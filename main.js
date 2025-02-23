"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const path = require("path");
const statesDefinition = require("./lib/statesDefinition.js");

class Fyta extends utils.Adapter {
	/**
	 * @param [options] options
	 */
	constructor(options) {
		super({
			...options,
			name: "fyta",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Clear all Data?
		if (this.config.clearOnStartup) {
			this.log.info("Delete all states and files as defined by config");

			// Delete objects and states
			try {
				// Holen aller Objekte im Namespace des Adapters
				const objects = await this.getAdapterObjectsAsync();

				// Löschen aller Datenpunkte
				for (const key of Object.keys(objects)) {
					if (key.indexOf(".info") > -1) {
						this.log.debug(`Skip state: ${key}`);
						continue;
					}
					await this.delObjectAsync(key);
					this.log.debug(`Deleted state: ${key}`);
				}

				this.log.info("All states deleted successfully");
			} catch (err) {
				this.log.error(`Error deleting states: ${err.message}`);
			}

			// Delete files
			try {
				const files = await this.readDirAsync(this.name, "plant");
				for (const file of files) {
					const filename = path.join("plant", file.file);
					await this.delFile(this.name, filename);
					this.log.debug(`Deleted file: ${filename}`);
				}
				this.log.info("All files deleted successfully");
			} catch (err) {
				this.log.error(`Error deleting files: ${err.message}`);
			}

			//this.config.clearOnStartup = false;
			this.changeOption("clearOnStartup", false);
		}

		// Define reccuring loading function
		let loadDataFailedCount = 0;
		const loadDataFailedMaxCount = 3;
		const intervalFn = () => {
			this.loadData().then((success) => {
				if (!success || success == null) {
					loadDataFailedCount++;

					// Failed more then 'loadDataFailedMaxCount' allows?
					if (loadDataFailedCount >= loadDataFailedMaxCount) {
						this.log.error(`Loading Data failed ${loadDataFailedMaxCount} times. Stop further loading and terminating adapter...`);
						if (this.loadDataInterval !== null) {
							this.clearInterval(this.loadDataInterval);
						}

						// Terminate Adapter
						if (typeof this.terminate === "function") {
							this.terminate(utils.EXIT_CODES.NO_ERROR);
						} else {
							process.exit(utils.EXIT_CODES.NO_ERROR);
						}
					}
				} else {
					loadDataFailedCount = 0;
				}
			});
		};

		// Initial load
		this.log.debug("Start initial load");
		intervalFn();

		// Setup Interval
		this.log.debug("Start interval");
		const interval = 30 * 60 * 1000;
		this.loadDataInterval = this.setInterval(intervalFn, interval);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param callback Callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			if (this.loadDataInterval !== null) {
				this.clearInterval(this.loadDataInterval);
			}

			callback();
		} catch (e) {
			callback(e);
		}
	}

	/**
	 * Logs into FYTA-API
	 *
	 * @param email eMail-Address
	 * @param password Password
	 */
	async fytaLogin(email, password) {
		// eMail and password set?
		if (this.config.email == "" || this.config.password == "") {
			this.log.error("eMail and/or password not provided. Please check config and restart.");
			return null;
		}

		this.log.info(`Loading gardens and plants for ${this.config.email}`);

		this.log.debug("Start fytaLogin()");

		let shouldStop = false;
		try {
			const response = await axios.post(
				"https://web.fyta.de/api/auth/login",
				{
					email: email,
					password: password,
				},
				{
					headers: {
						"Content-Type": "application/json",
						timeout: 10000, // only wait for 10s
					},
				},
			);

			// Check for successfull response
			this.log.debug(`Response status is ${response.status} (Login-Request)`);
			if (response.status === 200) {
				if (!response.data || !response.data.access_token) {
					this.log.error("Response does not contain access_token");
					return null;
				}

				this.setState("info.connection", true, true);
				this.log.debug("Got access_token, returning");

				return {
					token: response.data.access_token,
					shouldStop: false
				};
			} else {
				this.log.error("An error occured while logging into FYTA API (HTTP-Status ${response.status}).");
			}
		} catch (error) {
			// handle error			
			if (/\b401\b/.test(error)) {
				this.log.error("Login to FYTA API was rejected due to wrong Password. Please check config.");
				shouldStop = true;
			} else if (/\b404\b/.test(error)) {
				this.log.error("Login to FYTA API was rejected due to wrong eMail. Please check config.");
			} else {
				this.log.error("An unknown error occured while logging into FYTA API.");
				this.log.debug(error);
			}
		}

		this.setState("info.connection", false, true);

		return {
			shouldStop: shouldStop
		};
	}

	/**
	 * Loads gardens and plants from FYTA API
	 *
	 * @param token Bearer Token
	 */
	async fytaGetData(token) {
		this.log.debug("Start fytaGetData()");

		try {
			const response = await axios.get("https://web.fyta.de/api/user-plant", {
				headers: {
					Authorization: `Bearer ${token}`,
					timeout: 10000, // only wait for 10s
				},
			});

			// Check for successfull response
			this.log.debug(`Response status is ${response.status} (Data-Request)`);
			if (response.status === 200) {
				if (!response.data) {
					this.log.error("Response does not contain access_token");
				}

				return response.data;
			}
			this.log.error(`Retrieving gardens and plants was not successfull (HTTP-Status ${response.status})`);
		} catch (error) {
			// handle error
			this.log.error("An error occured while retrieving gardens and plants.");
			this.log.debug(error);
		}

		return null;
	}

	/**
	 * Loads data from FYTA cloud
	 */
	async loadData() {
		this.log.debug("loadData() started");

		if (this.loadDataCount === undefined) {
			this.loadDataCount = 0;
		}
		this.loadDataCount++;

		const resultLogin = await this.fytaLogin(this.config.email, this.config.password);
		if (resultLogin && resultLogin.token) {
			const data = await this.fytaGetData(resultLogin.token);

			if (data !== null) {
				this.log.info(`Retrieved ${data.gardens.length} gardens and ${data.plants.length} plants`);
				const virtualGardenNameCleaned = this.cleanName(this.config.virtualGardenName);

				//
				// Looping gardens
				data.gardens.forEach(async (garden) => {
					this.log.debug(`Handling garden ${garden.garden_name}`);

					// Create garden object
					this.log.debug("Create Object if not exists");
					const gardenObjectID = this.cleanName(garden.garden_name);
					this.setObjectNotExists(gardenObjectID, {
						type: "folder",
						common: {
							name: garden.garden_name,
							icon: "/icons/garden.png",
						},
						native: {},
					});

					// Create garden states
					this.log.debug("Create states...");
					this.setStatesOrCreate(gardenObjectID, garden, statesDefinition.garden);
				});

				//
				// looping plants
				data.plants.forEach(async (plant) => {
					this.log.debug(`Handling plant ${plant.nickname}`);

					// Create plant object
					let plantObjectID = "";
					//if(this.options.dataLayout == "nested"){
					// Place plant-object in garden

					// Defaulting to virtual garden
					plantObjectID = `${virtualGardenNameCleaned}.${this.cleanName(plant.nickname)}`;

					// Lookup for garden
					if (plant.garden && plant.garden.id) {
						const garden = data.gardens.find((g) => g.id === plant.garden.id);
						if (garden === null) {
							this.log.error(`Can't find defined garden for plant ${plant.nickname} (ID ${plant.id})`);
							return;
						}
						this.log.debug(`Belongs to garden ${JSON.stringify(garden)}`);
						plantObjectID = `${this.cleanName(garden.garden_name)}.${this.cleanName(plant.nickname)}`;
					}
					//}else if(this.options.dataLayout == "flat"){
					//	plantObjectID = this.cleanName(plant.nickname);
					//}else{
					//	this.log.error("Unknown value for option \"dataLayout\": " + JSON.stringify(this.options.dataLayout));
					//	return;
					//}

					// Need to create virtual garden?
					if (plantObjectID.indexOf(`${virtualGardenNameCleaned}.`) > -1) {
						this.getObject(virtualGardenNameCleaned, (err, obj) => {
							if (!obj) {
								this.log.debug("Virtual garden does not exist, creating...");
								this.setObjectNotExists(virtualGardenNameCleaned, {
									type: "folder",
									common: {
										name: {
											en: "Virtual garden for plants not belonging to any garden",
											de: "Virtueller Garten für Pflanzen, die zu keinem Garten gehören",
										},
										icon: "/icons/garden.png",
									},
									native: {},
								});
								this.setStateOrCreate(`${virtualGardenNameCleaned}.garden_name`, this.config.virtualGardenName, {
									common: {
										type: "string",
									},
								});
							}
						});
					}

					// Create plant object
					this.log.debug("Create plant-object if not exists");
					this.setObjectNotExists(plantObjectID, {
						type: "folder",
						common: {
							name: plant.nickname,
							icon: "/icons/plant.png",
						},
						native: {},
					});

					// Create plant states
					this.log.debug("Create states...");
					this.setStatesOrCreate(plantObjectID, plant, statesDefinition.plant);

					// Download Images if present
					["thumb_path", "origin_path"].forEach(async (property) => {
						if (plant[property] !== "") {
							const filename = path.join("plant", `${plant["id"]}_${property.split("_")[0]}.jpg`);

							const fileExists = await this.fileExistsAsync(this.name, filename);
							if (fileExists) {
								this.log.debug(`Skipped downloading file /${this.name}/${filename}`);
								return;
							}
							this.downloadImage(plant[property], filename, token)
								.then((filename) => {
									this.setStateOrCreate(`${plantObjectID}.${property}_local`, filename, {
										common: {
											name: property,
											type: "string",
											role: "url",
											read: true,
											write: false,
										},
									});
								})
								.catch((error) => {
									this.log.error(error.message);
								});
						}
					});

					// Looking for sensor
					if (plant.sensor !== null) {
						const sensorObjectID = `${plantObjectID}.sensor`;
						this.log.debug("Create sensor-object if not exists");
						this.setObjectNotExists(sensorObjectID, {
							type: "device",
							common: {
								name: "Sensor",
								icon: "/icons/sensor.png",
							},
							native: {},
						});

						this.setStatesOrCreate(sensorObjectID, plant.sensor, statesDefinition.sensor);
					}

					// Looking for hub
					if (plant.hub !== null) {
						const hubObjectID = `${plantObjectID}.hub`;
						this.log.debug("Create hub-object if not exists");
						this.setObjectNotExists(hubObjectID, {
							type: "device",
							common: {
								name: "Hub",
								icon: "/icons/hub.png",
							},
							native: {},
						});

						this.setStatesOrCreate(hubObjectID, plant.hub, statesDefinition.hub);
					}
				});

				this.setState("info.last_update", new Date().toLocaleString(), true);

				return true;
			}
			return true;
		}
		
		if(resultLogin && resultLogin.shouldStop !== null){
			return !resultLogin.shouldStop;
		}
		
		return false;
	}

	/**
	 * Removes unwantes characters from a string to use it as a state or object id
	 *
	 * @param string String to sanitize
	 */
	cleanName(string) {
		// Ersetze die deutschen Umlaute
		string = string
			.replace(/ä/g, "ae")
			.replace(/ö/g, "oe")
			.replace(/ü/g, "ue")
			.replace(/Ä/g, "Ae")
			.replace(/Ö/g, "Oe")
			.replace(/Ü/g, "Ue")
			.replace(/ß/g, "ss")
			.replace(/[ ]{1,}/g, "_");

		// Entferne alle Zeichen, die keine Buchstaben (A-Z, a-z) oder Zahlen (0-9) sind
		string = string.replace(/[^A-Za-z0-9-_]/g, "");

		return string;
	}

	/**
	 * Changes a option for current instance
	 *
	 * @param option option name
	 * @param value value
	 */
	changeOption(option, value) {
		const objectId = `system.adapter.${this.name}.${this.instance}`;

		// Get instances object
		this.getForeignObject(objectId, (err, obj) => {
			if (err || !obj) {
				this.log.error(`Error getting settings-object: ${err || "Object not found"}`);
				return;
			}

			// Change option
			obj.native[option] = value;

			// Speichere die Änderungen
			this.extendForeignObject(objectId, obj, (err) => {
				if (err) {
					this.log.error(`Error saving instances settings: ${err}`);
				} else {
					this.log.debug(`Changes setting "${option}" to ${JSON.stringify(value)}`);
				}
			});
		});
	}

	/**
	 * Loops through defined array of states and sets or creates theom from retrieved API data
	 *
	 * @param strParentObjectID parent Object ID
	 * @param obj object from api
	 * @param arrStatesDefinition states definition to transform
	 */
	setStatesOrCreate(strParentObjectID, obj, arrStatesDefinition) {
		for (const [stateSourceObject, stateDefinition] of Object.entries(arrStatesDefinition)) {
			if (!(stateSourceObject in obj) && !("def" in stateDefinition)) {
				this.log.warn(`There is not a property "${stateSourceObject}"`);
				continue;
			}

			const stateID = `${strParentObjectID}.${stateDefinition.name}`;
			let stateValue = null;
			if (stateSourceObject in obj) {
				stateValue = obj[stateSourceObject];
			}
			if (stateValue === null && "def" in stateDefinition) {
				stateValue = stateDefinition.def;
			}

			this.log.debug(`Set State ${stateID} to ${stateValue} (type ${stateDefinition.type})`);

			// Create state object
			this.setStateOrCreate(stateID, stateValue, {
				common: {
					...{
						role: "value",
						read: true,
						write: false,
					},
					...stateDefinition,
				},
				state: {
					read: true,
					write: false,
				},
			});
		}
	}

	/**
	 * Sets and optionally creates a state if it doies not exists
	 *
	 * @param stateID State ID
	 * @param stateValue State Value
	 * @param options	Option
	 */
	setStateOrCreate(stateID, stateValue, options) {
		if (!options || !options.common || !options.common.type) {
			this.log.error(`No type defined for object ${stateID}!`);
			return;
		}

		const common = {
			...{
				role: "value",
				read: true,
				write: false,
			},
			...options.common,
		};

		this.setObjectNotExists(
			stateID,
			{
				type: "state",
				common: common,
				native: {},
			},
			(err) => {
				if (!err) {
					// Set state
					this.setState(stateID, {
						val: stateValue,
						ack: true,
					});
				} else {
					this.log.error(`Error creating state ${stateID}: ${err}`);
				}
			},
		);
	}

	/**
	 * Downloads a custm plant image
	 *
	 * @param url	URL
	 * @param filename filename
	 * @param token Bearer Token
	 */
	async downloadImage(url, filename, token) {
		return new Promise((resolve, reject) => {
			this.log.debug(`Download ${url} -> ${filename}`);

			axios({
				method: "get",
				url: url,
				responseType: "arraybuffer", // Ensures we handle the data as a stream
				headers: {
					Authorization: `Bearer ${token}`,
					timeout: 10000, // only wait for 10s
				},
			})
				.then((response) => {
					if (!response.data) {
						reject(new Error("Response does not contain data"));
					}

					this.log.debug("Download successfull");

					const buffer = Buffer.from(response.data, "binary");
					this.writeFileAsync(this.name, filename, buffer).then(() => {
						resolve(`/${path.join(this.name, filename)}`);
					});
				})
				.catch((error) => {
					reject(new Error(`Failed to download image: ${error.message}`));
				});
		});
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param [options] Optionen
	 */
	module.exports = (options) => new Fyta(options);
} else {
	// otherwise start the instance directly
	new Fyta();
}
