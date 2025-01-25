"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");

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
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here

		this.log.info("Loading gardens and plants for " + this.config.email);
		//this.log.info("PW" + this.config.password);
		//return;


		this.log.debug("direct call");
		this.loadData();
		//return;

		//this.loadDataInterval = () => {
		//	this.log.debug("in anon func");
		//	this.loadData();
		//
		//	/*
		//	let interval = 5 * 1000;
		//	return(setInterval(() => {
		//		this.loadData();
		//	}, interval));
		//	*/
		//}

		/*

		try {
            // Holen aller Objekte im Namespace des Adapters
            const objects = await this.getAdapterObjectsAsync();
            const keys = Object.keys(objects);

            // Löschen aller Datenpunkte
            for (const key of keys) {
                this.log.info(`Lösche Datenpunkt: ${key}`);
                await this.delObjectAsync(key);
            }

            this.log.info("Alle Datenpunkte erfolgreich gelöscht.");
        } catch (err) {
            this.log.error(`Fehler beim Löschen der Datenpunkte: ${err.message}`);
        }
		*/

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

			clearInterval(this.loadDataInterval);

			callback();
		} catch (e) {
			callback();
		}
	}

	/**
	 * Logs into FYTA-API
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
				}

				this.log.debug("Got access_token, returning");
				return response.data.access_token;
			}

		} catch(error){
			// handle error
			this.log.error("An error occured while logging into FYTA API. Please check your data and restart adapter.");
			this.log.debug(error);

			// Terminate Adapter
			if (typeof this.terminate === "function") {
				this.terminate(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			} else {
				process.exit(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
			}
		}

		return null;
	}

	/**
	 * Loads gardens and plants from FYTA API
	 */
	async fytaGetData(token){
		this.log.debug("Start fytaGetData()");

		try{

			const response = await axios.get("https://web.fyta.de/api/user-plant", {
				headers: {
					"Authorization": "Bearer " + token,
				},
			});

			// Check for successfull response
			this.log.debug("Response status is " + response.status + " (Data-Request)");
			if (response.status === 200) {

				if (!response.data) {
					this.log.error("Response does not contain access_token");
				}

				return response.data;
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
					if(plantObjectID==""){
						// Place plant-object in garden
						if(plant.garden && plant.garden.id){
							const garden = data.gardens.find(g => g.id === plant.garden.id);
							if(garden === null){
								this.log.error("Can't find defined garden for plant " + plant.nickname + " (ID " + plant.id + ")");
								return;
							}
							this.log.debug("Belongs to garden " + JSON.stringify(garden));
							plantObjectID = this.cleanName(garden.garden_name) + "." + this.cleanName(plant.nickname);
						}
					}

					// Create plant object
					this.log.debug("Create plant-object if not exists");
					this.setObjectNotExists(plantObjectID, {
						type: "device",
						common: {
							name: plant.nickname,
						},
						native: {},
					});

					// Create plant states
					this.log.debug("Create states...");
					const statesDefintion = {
						"id": 					{name: "ID", 					type: "number" 		},
						"nickname": 			{name: "nickname", 				type: "string" 		},
						"scientific_name": 		{name: "scientific_name", 		type: "string" 		},
						"common_name": 			{name: "common_name", 			type: "string" 		},
						"status": 				{name: "status", 				type: "number"		},
						"thumb_path": 			{name: "thumb_path", 			type: "string" 		},
						"origin_path": 			{name: "origin_path", 			type: "string" 		},
						"plant_thumb_path": 	{name: "plant_thumb_path", 		type: "string" 		},
						"plant_origin_path": 	{name: "plant_origin_path", 	type: "string" 		},
						"is_shared":			{name: "is_shared",				type: "boolean",	defaultValue: false},

						"temperature_status": 	{name: "temperature_status",	type: "number"		},
						"light_status": 		{name: "light_status", 			type: "number"		},
						"moisture_status": 		{name: "moisture_status", 		type: "number"		},
						"salinity_status": 		{name: "salinity_status", 		type: "number"		},
						"nutrients_status": 	{name: "nutrients_status", 		type: "number"		},


						"isSilent": 			{name: "isSilent", 				type: "boolean"		},
						"isDoingGreat": 		{name: "isDoingGreat", 			type: "boolean"		}
					};
					for (const [stateSourceObject, stateDefinition] of Object.entries(statesDefintion)) {

						const stateID = plantObjectID + "." + stateDefinition.name;
						let stateValue = null;
						if(stateSourceObject in plant){
							stateValue = plant[stateSourceObject];
						}else if("defaultValue" in stateDefinition){
							stateValue = stateDefinition.defaultValue;
						}

						this.log.debug("Set State " + stateID + " to " + stateValue + " (type " + stateDefinition.type + ")");

						// Create state object
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
						});
						// Set state
						this.setState(stateID, {
							val: stateValue,
							ack: true
						});

					}

				});


			}

		}
	}

	cleanName(str){
		// Ersetze die deutschen Umlaute
		str = str.replace(/ä/g, "ae")
				.replace(/ö/g, "oe")
				.replace(/ü/g, "ue")
				.replace(/Ä/g, "Ae")
				.replace(/Ö/g, "Oe")
				.replace(/Ü/g, "Ue")
				.replace(/ß/g, "ss")
				.replace(/[ ]*/g, "_");

		// Entferne alle Zeichen, die keine Buchstaben (A-Z, a-z) oder Zahlen (0-9) sind
		str = str.replace(/[^A-Za-z0-9-]/g, "");

		return str;
	}

	// Rekursive Funktion, um in verschachtelten Objekten nach einem Wert zu suchen
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