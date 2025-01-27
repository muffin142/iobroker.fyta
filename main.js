"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const path = require('path');
const fs = require('fs');

class Fyta extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "fyta",
		});
		this.on("ready", this.onReady.bind(this));
		//this.on("stateChange", this.onStateChange.bind(this));
		// this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));
		
		this.filesBasePath =  path.join(__dirname, "../../iobroker-data/files");
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {

		// Clear all Data?
		if(this.config.clearOnStartup){
			this.log.info("Delete all states as defined by config")
			try {
				// Holen aller Objekte im Namespace des Adapters
				const objects = await this.getAdapterObjectsAsync();

				// Löschen aller Datenpunkte
				for (const key of Object.keys(objects)) {
					if(key.indexOf("0.info") > -1){
						this.log.debug("Skip state: " + key);
						continue;
					}					
					await this.delObjectAsync(key);
					this.log.debug("Deleted state: " + key);
				}

				this.log.info("All states deleted successfully");
			} catch (err) {
				this.log.error("Error deleting states: " + err.message);
			}
			//this.config.clearOnStartup = false;
			this.changeOption("clearOnStartup", false);
		}		
		
		// eMail and password set?
		if(this.config.email == "" || this.config.password == ""){
			this.log.error("eMail and/or password not provided. Please check config and restart.");
			return;			
		}		

		this.log.info("Loading gardens and plants for " + this.config.email);

		// Staring interval if initial lod is successfull
		this.loadDataInterval = (() => {
			
			// Initial load
			this.log.debug("Start initial load");
			let result = this.loadData();
		
			
			if(result){
				this.log.debug("Initial load sucessfull, starting interval");
				let interval = 30 * 60 * 1000;
				return(setInterval(() => {
					let result = this.loadData();
					if(!result || result == null){
						clearInterval(this.loadDataInterval);
						this.log.info("Stopped interval because of previous errors.");
					}
				}, interval));
			}else{
				this.log.info("Stopped interval because of previous errors.");
			}
			
			return null;
		})();		

	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			if(this.loadDataInterval !== null)
				clearInterval(this.loadDataInterval);

			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Logs into FYTA-API
	 * @param {string} email
	 * @param {string} password
	 */
	async fytaLogin(email, password){
		this.log.debug("Start fytaLogin()");

		try{

			const response = await axios.post("https://web.fyta.de/api/auth/login", {
				email: 		email,
				password:	password
			},{
				headers: {
					"Content-Type": "application/json",
				}
			});

			// Check for successfull response
			this.log.debug("Response status is " + response.status + " (Login-Request)");
			if (response.status === 200) {

				if (!response.data || !response.data.access_token) {
					this.log.error("Response does not contain access_token");
					this.exitAdapter();
					return;
				}

				this.setState("info.connection", true, true);
				this.log.debug("Got access_token, returning");
				
				return response.data.access_token;
				
			}else{
				this.log.error("Login was not successfull (HTTP-Status " + response.status + ")");
			}

		} catch(error){
			// handle error
			this.log.error("An error occured while logging into FYTA API. Please check config and restart.");
			this.log.debug(error);
		}

		this.setState("info.connection", false, true);
		
		return null;
	}

	/**
	 * Loads gardens and plants from FYTA API
	 * @param {string} token
	 */
	async fytaGetData(token){
		this.log.debug("Start fytaGetData()");

		try{

			const response = await axios.get("https://web.fyta.de/api/user-plant", {
				headers: {
					"Authorization": "Bearer " + token,
				}
			});

			// Check for successfull response
			this.log.debug("Response status is " + response.status + " (Data-Request)");
			if (response.status === 200) {

				if (!response.data) {
					this.log.error("Response does not contain access_token");
				}

				return response.data;
			}else{
				this.log.error("Retrieving gardens and plants was not successfull (HTTP-Status " + response.status + ")");
			}

		} catch(error){
			// handle error
			this.log.error("An error occured while retrieving gardens and plants.");
			this.log.debug(error);
		}

		return null;
	}

	/**
	 * Loads data from FYTA cloud
	 */
	async loadData(){
		this.log.debug("loadData() started");

		const token = await this.fytaLogin(this.config.email, this.config.password);
		if(token !== null){
			const data = await this.fytaGetData(token);

			if(data !== null){
				this.log.info("Retrieved " + data.gardens.length + " gardens and " + data.plants.length + " plants");
				const virtualGardenNameCleaned = this.cleanName(this.config.virtualGardenName);

				// Looping gardens
				for (const garden of data.gardens) {
					this.log.debug("Handling garden " + garden.garden_name);

					// Create garden object
					this.log.debug("Create Object if not exists");
					const gardenObjectID = this.cleanName(garden.garden_name);
					this.setObjectNotExists(gardenObjectID, {
						type: "device",
						common: {
							name: garden.garden_name,
							icon: "/icons/garden.png"
						},
						native: {},
					});

					// Create garden states
					this.log.debug("Create states...");
					const statesDefintion = {
						"id": 			{name: "ID", 			type: "number" 		},
						"garden_name": 	{name: "garden_name", 	type: "string" 		},
						"origin_path": 	{name: "origin_path", 	type: "string" 		},
						"thumb_path": 	{name: "thumb_path", 	type: "string" 		},
						"mac_address": 	{name: "mac_address", 	type: "string" 		},
						"is_shared":	{name: "is_shared",		type: "boolean",	defaultValue: false}
					};
					for (const [stateSourceObject, stateDefinition] of Object.entries(statesDefintion)) {

						const stateID = gardenObjectID + "." + stateDefinition.name;
						let stateValue = null;
						if(stateSourceObject in garden){
							stateValue = garden[stateSourceObject];
						}else if("defaultValue" in stateDefinition){
							stateValue = stateDefinition.defaultValue;
						}

						this.log.debug("Set State " + stateID + " to " + stateValue + " (type " + stateDefinition.type + ")");

						this.setObjectNotExists(stateID, {
							type: "state",
							common: {
								name: stateDefinition.name,
								type: stateDefinition.type,
								role: "value",
								read: true,
								write: false,
							},
							native: {},
						}, (err) => {
							if (!err) {
								this.setState(stateID, {
									val: stateValue,
									ack: true,
								});
							} else {
								this.log.error("Error creating state " + stateID + ": " + err);
							}
						});
					}
				}

				// looping plants
				data.plants.forEach((plant) => {
					this.log.debug("Handling plant " + plant.nickname);

					// Create plant object
					let plantObjectID = "";
					//if(this.options.dataLayout == "nested"){
						// Place plant-object in garden
						
						// Defaulting to virtual garden
						plantObjectID =  virtualGardenNameCleaned + "." + this.cleanName(plant.nickname);
						
						// Lookup for garden
						if(plant.garden && plant.garden.id){
							const garden = data.gardens.find(g => g.id === plant.garden.id);
							if(garden === null){
								this.log.error("Can't find defined garden for plant " + plant.nickname + " (ID " + plant.id + ")");
								return;
							}
							this.log.debug("Belongs to garden " + JSON.stringify(garden));
							plantObjectID = this.cleanName(garden.garden_name) + "." + this.cleanName(plant.nickname);
						}
					//}else if(this.options.dataLayout == "flat"){
					//	plantObjectID = this.cleanName(plant.nickname);
					//}else{
					//	this.log.error("Unknown value for option \"dataLayout\": " + JSON.stringify(this.options.dataLayout));
					//	return;
					//}
					
					// Need to create virtual garden?
					if(plantObjectID.indexOf(virtualGardenNameCleaned + ".") > -1){
						this.setObjectNotExists(virtualGardenNameCleaned, {
							type: "device",
							common: {
								name: {
									"en": "Virtual garden for plants not belonging to any garden",
									"de": "Virtueller Garten für Pflanzen, die zu keinem Garten gehören"
								},
								icon: "/icons/garden.png"
							},
							native: {},
						});
					}

					// Create plant object
					this.log.debug("Create plant-object if not exists");
					this.setObjectNotExists(plantObjectID, {
						type: "device",
						common: {
							name: plant.nickname,
							icon: "/icons/plant.png"
						},
						native: {},
					});

					// Create plant states
					this.log.debug("Create states...");
					const plantStatesDefintion = {
						"id": 					{name: "ID", 					type: "number" 					},
						"nickname": 			{name: "nickname", 				type: "string",		dev: ""		},
						"scientific_name": 		{name: "scientific_name", 		type: "string",		dev: ""		},
						"common_name": 			{name: "common_name", 			type: "string",		dev: ""		},
						"status": 				{name: "status", 				type: "number",		dev: 3,		states: {"0":"User Plant deleted","1":"User Plant good status","2":"User Plant bad status","3":"User Plant no sensor"}},
						"wifi_status":			{name: "wifi_status",			type: "number",		dev: -1,	states: {"-1": "Never connected to any hub or user doesnt have any hub or plant doesnt have sensor", "0":"Lost connection to all previously connected hubs", "1":"Is connected to at least one hub", "2":"Error in connecting hub OR hub connection lost within a specific time range"}},
						"thumb_path": 			{name: "thumb_path", 			type: "string",		dev: ""		},
						"origin_path": 			{name: "origin_path", 			type: "string",		dev: ""		},
						"plant_thumb_path": 	{name: "plant_thumb_path", 		type: "string",		dev: ""		},
						"plant_origin_path": 	{name: "plant_origin_path", 	type: "string",		def: ""		},
						"is_shared":			{name: "is_shared",				type: "boolean",	def: false	},

						"temperature_status": 	{name: "temperature_status",	type: "number",		def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"light_status": 		{name: "light_status", 			type: "number",		def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"moisture_status": 		{name: "moisture_status", 		type: "number",		def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"salinity_status": 		{name: "salinity_status", 		type: "number",		def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"nutrients_status": 	{name: "nutrients_status", 		type: "number",		def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},

						"has_remote_hub":		{name: "has_remote_hub",		type: "boolean",	def: false	},
						"has_remote_sensor":	{name: "has_remote_sensor",		type: "boolean",	def: false	},

						"isSilent": 			{name: "isSilent", 				type: "boolean",	def: false	},
						"isDoingGreat": 		{name: "isDoingGreat", 			type: "boolean",	def: false	}
					};
					for (const [stateSourceObject, stateDefinition] of Object.entries(plantStatesDefintion)) {

						const stateID = plantObjectID + "." + stateDefinition.name;
						let stateValue = null;
						if(stateSourceObject in plant){
							stateValue = plant[stateSourceObject];
						}
						if(stateValue === null && "def" in stateDefinition){
							stateValue = stateDefinition.def;
						}

						this.log.debug("Set State " + stateID + " to " + stateValue + " (type " + stateDefinition.type + ")");

						// Create state object
						this.setStateOrCreate(stateID, stateValue, {
							common: {
								...{
									role: "value",
									read: true,
									write: false
								},
								...stateDefinition
							},
							state: {
								read: true,
								write: false
							}
						});				
					}
					
					// Download Images if present
					["thumb_path", "origin_path"].forEach(async (property )=> {
						if(plant[property] !== ""){							

							const filename = path.join("plant", plant["id"] + "_" + (property.split("_")[0]) + ".jpg");

							const fileExists = await this.fileExistsAsync(this.name, filename);
							if(fileExists){
								this.log.debug("Skipped downloading file /" + this.name + "/" +  filename);
								return;
							}
							this.downloadImage(plant[property], filename, token)
								.then((filename) => {	
									this.setStateOrCreate(plantObjectID + "." + property + "_local", filename, {
										common: {
											name: property,
											type: "string",
											read: true,
											write: false
										}
									});
								})
								.catch((error) => {
									this.log.error(error.message);
								});								
						}
					});
					
					// Looking for sensor
					if(plant.sensor !== null){
						const sensorObjectID = plantObjectID + ".sensor"
						this.log.debug("Create sensor-object if not exists");
						this.setObjectNotExists(sensorObjectID, {
							type: "device",
							common: {
								name: "Sensor",
								icon: "/icons/sensor.png"
							},
							native: {},
						});
						
						const sensorStatesDefinition = {
							"id": 					{name: "ID", 					type: "string" 					},
							"status": 				{name: "status", 				type: "number",		dev: 0,		states: {"0":"none","1":"correct","2":"error"} },
							"version": 				{name: "version", 				type: "string",		dev: ""		},
							"is_battery_low": 		{name: "is_battery_low", 		type: "boolean",	dev: false	},
							"received_data_at": 	{name: "received_data_at", 		type: "string",		dev: ""		},
						};
						for (const [stateSourceObject, stateDefinition] of Object.entries(sensorStatesDefinition)) {

							const stateID = sensorObjectID + "." + stateDefinition.name;
							let stateValue = null;
							if(stateSourceObject in plant.sensor ){
								stateValue = plant.sensor[stateSourceObject];
							}
							if(stateValue === null && "def" in stateDefinition){
								stateValue = stateDefinition.def;
							}

							this.log.debug("Set State " + stateID + " to " + stateValue + " (type " + stateDefinition.type + ")");

							// Create state object
							this.setStateOrCreate(stateID, stateValue, {
								common: {
									...{
										role: "value",
										read: true,
										write: false
									},
									...stateDefinition
								},
								state: {
									read: true,
									write: false
								}
							});				
						}						
					}
					
					// Looking for hub
					if(plant.hub !== null){
						const hubObjectID = plantObjectID + ".hub"
						this.log.debug("Create hub-object if not exists");
						this.setObjectNotExists(hubObjectID, {
							type: "device",
							common: {
								name: "Hub",
								icon: "/icons/hub.png"
							},
							native: {},
						});
						
						const hubStatesDefinition = {
							"id": 					{name: "ID", 					type: "number" 					},
							"hub_id": 				{name: "hub_id", 				type: "string",		dev: ""		},
							"hub_name": 			{name: "hub_id", 				type: "string",		dev: ""		},
							"version": 				{name: "version", 				type: "string",		dev: ""		},							
							"status": 				{name: "status", 				type: "number",		dev: 0,		states: {"0":"none","1":"correct","2":"error"} },
							"received_data_at": 	{name: "received_data_at", 		type: "string",		dev: ""		},
							"reached_hub_at": 		{name: "reached_hub_at", 		type: "string",		dev: ""		},
						};
						for (const [stateSourceObject, stateDefinition] of Object.entries(hubStatesDefinition)) {

							const stateID = hubObjectID + "." + stateDefinition.name;
							let stateValue = null;
							if(stateSourceObject in plant.hub ){
								stateValue = plant.hub[stateSourceObject];
							}
							if(stateValue === null && "def" in stateDefinition){
								stateValue = stateDefinition.def;
							}

							this.log.debug("Set State " + stateID + " to " + stateValue + " (type " + stateDefinition.type + ")");

							// Create state object
							this.setStateOrCreate(stateID, stateValue, {
								common: {
									...{
										role: "value",
										read: true,
										write: false
									},
									...stateDefinition
								},
								state: {
									read: true,
									write: false
								}
							});				
						}				
					}
				});

				this.setState("info.last_update", (new Date()).toLocaleString(), true);

				return true;
			}		
			return true;
		}
		return false;
	}

	/**
	 * Removes unwantes characters from a string to use it as a state or object id
	 * @param {string} string
	 */
	cleanName(string){
		// Ersetze die deutschen Umlaute
		string = string.replace(/ä/g, "ae")
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

	// Rekursive Funktion, um in verschachtelten Objekten nach einem Wert zu suchen
	/*
	getNestedValue(obj, keys) {
		// Wenn keys ein String ist, teile ihn in ein Array
		if (typeof keys === "string") {
			keys = keys.split(".");
		}
		const key = keys.shift(); // Hole den ersten Schlüssel aus der Liste
		if (obj && obj[key] !== undefined) {
			if (keys.length === 0) {
				return obj[key]; // Wenn keine weiteren Schlüssel mehr da sind, den Wert zurückgeben
			}
			return this.getNestedValue(obj[key], keys); // Rekursiver Aufruf mit dem restlichen Schlüssel
		}
		return undefined; // Wenn der Wert nicht gefunden wird
	}
	*/
	
	/**
	 * Stops execiution of adapter. Depending on instance settings it may restart.
	 */
	exitAdapter(){
		// Terminate Adapter
		if (typeof this.terminate === "function") {
			this.terminate(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
		} else {
			process.exit(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
		}
	}
	
	/**
	 * Changes a option for current instance
	 * @param {string} option
	 * @param {string | boolean | number | null} value
	 */
	changeOption(option, value) {

		const objectId = "system.adapter." + this.name + "." + this.instance;

		// Get instances object
		this.getForeignObject(objectId, (err, obj) => {
			if (err || !obj) {
				adapter.log.error("Error getting settings-object: " + (err || 'Object not found'));
				return;
			}

			// Change option
			obj.native[option] = value;

			// Speichere die Änderungen
			this.extendForeignObject(objectId, obj, (err) => {
				if (err) {
					this.log.error("Error saving instances settings: " + err);
				} else {
					this.log.debug("Changes setting \"" + option + "\" to " + JSON.stringify(value));
				}
			});
		});
	}

	/**
	 * Sets and optionally creates a state if it doies not exists
	 * @param {string} stateID
	 * @param {string | boolean | number | null} stateValue
	 */
	setStateOrCreate(stateID, stateValue, options){
		
		if(!options || !options.common || !options.common.type){
			this.log.error("No type defined for object " + stateID + "!")
			return;
		}
		
		const common = {
			...{
				//name: "defaultname",
				//type: "string",
				role: "value",
				read: true,
				write: false,
			},
			...options.common
		};			

		this.setObjectNotExists(stateID, {
			type: "state",
			common: common,
			native: {},
		}, (err) => {
			if (!err) {
				// Set state
				this.setState(stateID, {
					val: stateValue,
					ack: true
				});
			} else {
				this.log.error("Error creating state " + stateID + ": " + err);
			}
		});
	}

	/**
	 * Downloads a custm plant image
	 * @param {string} url
	 * @param {string} filename
	 * @param {string} token
	 */
	async downloadImage(url, filename, token) {		
		
		return new Promise((resolve, reject) => {
			
			//const savePath = path.join(this.filesBasePath, filename);
			
			// Create path recursive
			/*
			try{
				fs.mkdirSync(savePath.substring(0, savePath.lastIndexOf('/')), { recursive: true }); 
			}catch(error){
				reject(new Error("Failed to create path: " + error.message));
			}*/				
			
			this.log.debug("Download " + url + " -> " + filename);
			
			axios({
				method: 'get',
				url: url,
				responseType: 'arraybuffer', // Ensures we handle the data as a stream
				headers: {
					"Authorization": "Bearer " + token,
				}
			})
			.then((response) => {	

				if (!response.data) {
					reject(new Error("Response does not contain data"));
				}			
				
				this.log.debug("Download successfull");
				
				const buffer = Buffer.from(response.data, 'binary');				
				this.writeFileAsync(this.name, filename, buffer)
					.then(() => {
						resolve("/" + path.join(this.name, filename));
					});				
				

				/*
				// Create a writable stream to save the file
				const writer = fs.createWriteStream(savePath);

				// Pipe the response stream to the file
				response.data.pipe(writer);

				// Handle stream events
				writer.on('finish', () => {
					this.log.debug("Download successfull");
					resolve(filename);
				});
				writer.on('error', (err) => {
					fs.unlink(savePath, () => {}); // Clean up incomplete file
					reject(err);
				});
				*/
			
				
			})
            .catch((error) => {
				reject(new Error("Failed to download image: " + error.message));
			});			
		});			
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	/*
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}
	*/

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Fyta(options);
} else {
	// otherwise start the instance directly
	new Fyta();
}