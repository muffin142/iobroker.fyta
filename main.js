"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");
const path = require("path");

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
		this.on("unload", this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {

		// Clear all Data?
		if(this.config.clearOnStartup){
			this.log.info("Delete all states and files as defined by config");

			// Delete objects and states
			try {
				// Holen aller Objekte im Namespace des Adapters
				const objects = await this.getAdapterObjectsAsync();

				// Löschen aller Datenpunkte
				for (const key of Object.keys(objects)) {
					if(key.indexOf(".info") > -1){
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

			// Delete files
			try{
				const files = await this.readDirAsync(this.name, "plant");
				for(const file of files){
					const filename = path.join("plant", file.file);
					await this.delFile(this.name, filename);
					this.log.debug("Deleted file: " + filename);
				}
				this.log.info("All files deleted successfully");
			}catch(err){
				this.log.error("Error deleting files: " + err.message);
			}

			//this.config.clearOnStartup = false;
			this.changeOption("clearOnStartup", false);
		}


		// eMail and password set?
		if(this.config.email == "" || this.config.password == ""){
			this.log.error("eMail and/or password not provided. Please check config and restart.");
			this.exitAdapter(utils.ExitCodes.INVALID_ADAPTER_CONFIG);
			return;
		}

		this.log.info("Loading gardens and plants for " + this.config.email);

		// Initial load
		this.loadDataInterval = null;

		this.log.debug("Start initial load");
		const result = await this.loadData();

		if(result){
			this.log.debug("Initial load sucessfull, starting interval");
			const interval = 30 * 60 * 1000;
			this.loadDataInterval = this.setInterval(() => {
				this.loadData()
					.then((result)=> {
						if(!result || result == null){
							this.clearInterval(this.loadDataInterval);
							this.log.error("Stopped interval because of previous errors.");
							this.exitAdapter();
						}
					});
			}, interval);
		}else{
			this.log.error("Interval not started because of previous errors.");
			this.exitAdapter();
			return;
		}
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
				this.clearInterval(this.loadDataInterval);

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
					timeout: 10000 // only wait for 10s
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
					timeout: 10000 // only wait for 10s
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

				//
				// Looping gardens
				data.gardens.forEach(async (garden) => {
					this.log.debug("Handling garden " + garden.garden_name);

					// Create garden object
					this.log.debug("Create Object if not exists");
					const gardenObjectID = this.cleanName(garden.garden_name);
					this.setObjectNotExists(gardenObjectID, {
						type: "folder",
						common: {
							name: garden.garden_name,
							icon: "/icons/garden.png"
						},
						native: {},
					});

					// Create garden states
					this.log.debug("Create states...");
					const statesDefintion = {
						"id": 			{name: "ID", 			type: "number", 	role: "value"			},
						"garden_name": 	{name: "garden_name", 	type: "string",		role: "info.name"		},
						"origin_path": 	{name: "origin_path", 	type: "string",		role: "url",			def: "" },
						"thumb_path": 	{name: "thumb_path", 	type: "string",		role: "url",			def: ""	},
						"is_shared":	{name: "is_shared",		type: "boolean",	role: "value",			def: false}
					};
					this.setStatesOrCreate(gardenObjectID, garden, statesDefintion);
				});

				//
				// looping plants
				data.plants.forEach(async (plant) => {
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
						this.getObject(virtualGardenNameCleaned, (err, obj) => {
							if (!obj) {
								this.log.debug("Virtual garden does not exist, creating...");
								this.setObjectNotExists(virtualGardenNameCleaned, {
									type: "folder",
									common: {
										name: {
											"en": "Virtual garden for plants not belonging to any garden",
											"de": "Virtueller Garten für Pflanzen, die zu keinem Garten gehören"
										},
										icon: "/icons/garden.png"
									},
									native: {},
								});
								this.setStateOrCreate(virtualGardenNameCleaned + ".garden_name", this.config.virtualGardenName, {common:{type: "string"}});
							}
						});
					}

					// Create plant object
					this.log.debug("Create plant-object if not exists");
					this.setObjectNotExists(plantObjectID, {
						type: "folder",
						common: {
							name: plant.nickname,
							icon: "/icons/plant.png"
						},
						native: {},
					});

					// Create plant states
					this.log.debug("Create states...");
					const plantStatesDefintion = {
						"id": 					{name: "ID", 					type: "number", 	role: "value"			},
						"nickname": 			{name: "nickname", 				type: "string",		role: "info.name", 		def: ""		},
						"scientific_name": 		{name: "scientific_name", 		type: "string",		role: "info.name",		def: ""		},
						"common_name": 			{name: "common_name", 			type: "string",		role: "info.name",		def: ""		},
						"status": 				{name: "status", 				type: "number",		role: "info.status",	def: 3,		states: {"0":"User Plant deleted","1":"User Plant good status","2":"User Plant bad status","3":"User Plant no sensor"}},
						"wifi_status":			{name: "wifi_status",			type: "number",		role: "info.status",	def: -1,	states: {"-1": "Never connected to any hub or user doesnt have any hub or plant doesnt have sensor", "0":"Lost connection to all previously connected hubs", "1":"Is connected to at least one hub", "2":"Error in connecting hub OR hub connection lost within a specific time range"}},
						"thumb_path": 			{name: "thumb_path", 			type: "string",		role: "url", 			def: ""		},
						"origin_path": 			{name: "origin_path", 			type: "string",		role: "url",			def: ""		},
						"plant_thumb_path": 	{name: "plant_thumb_path", 		type: "string",		role: "url",			def: ""		},
						"plant_origin_path": 	{name: "plant_origin_path", 	type: "string",		role: "url",			def: ""		},
						"is_shared":			{name: "is_shared",				type: "boolean",	role: "value",			def: false	},

						"temperature_status": 	{name: "temperature_status",	type: "number",		role: "info.status",	def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"light_status": 		{name: "light_status", 			type: "number",		role: "info.status",	def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"moisture_status": 		{name: "moisture_status", 		type: "number",		role: "info.status",	def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"salinity_status": 		{name: "salinity_status", 		type: "number",		role: "info.status",	def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},
						"nutrients_status": 	{name: "nutrients_status", 		type: "number",		role: "info.status",	def: 0,		states: {"0":"No Data", "1":"Too Low", "2":"Low", "3":"Perfect", "4":"High", "5":"Too High"}},

						"has_remote_hub":		{name: "has_remote_hub",		type: "boolean",	role: "value",			def: false	},
						"has_remote_sensor":	{name: "has_remote_sensor",		type: "boolean",	role: "value",			def: false	},

						"isSilent": 			{name: "isSilent", 				type: "boolean",	role: "value",			def: false	},
						"isDoingGreat": 		{name: "isDoingGreat", 			type: "boolean",	role: "value",			def: false	}
					};
					this.setStatesOrCreate(plantObjectID, plant, plantStatesDefintion);

					// Download Images if present
					["thumb_path", "origin_path"].forEach(async (property)=> {
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
											role: "url",
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
						const sensorObjectID = plantObjectID + ".sensor";
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
							"id": 					{name: "ID", 					type: "string",		role: "value" 				},
							"status": 				{name: "status", 				type: "number",		role: "info.status",		def: 0,		states: {"0":"none","1":"correct","2":"error"} },
							"version": 				{name: "version", 				type: "string",		role: "info.firmware",		def: ""		},
							"is_battery_low": 		{name: "is_battery_low", 		type: "boolean",	role: "indicator.lowbat",	def: false	},
							"received_data_at": 	{name: "received_data_at", 		type: "string",		role: "date",				def: ""		},
						};
						this.setStatesOrCreate(sensorObjectID, plant.sensor, sensorStatesDefinition);
					}

					// Looking for hub
					if(plant.hub !== null){
						const hubObjectID = plantObjectID + ".hub";
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
							"id": 					{name: "ID", 					type: "number", 	role: "value" 				},
							"hub_id": 				{name: "hub_id", 				type: "string",		role: "value",				def: ""		},
							"hub_name": 			{name: "hub_id", 				type: "string",		role: "info.name",			def: ""		},
							"version": 				{name: "version", 				type: "string",		role: "info.firmware",		def: ""		},
							"status": 				{name: "status", 				type: "number",		role: "info.status",		def: 0,		states: {"0":"none","1":"correct","2":"error"} },
							"received_data_at": 	{name: "received_data_at", 		type: "string",		role: "date",				def: ""		},
							"reached_hub_at": 		{name: "reached_hub_at", 		type: "string",		role: "date",				def: ""		},
						};
						this.setStatesOrCreate(hubObjectID, plant.hub, hubStatesDefinition);
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

	/**
	 * Stops execiution of adapter. Depending on instance settings it may restart.
	 * @param {utils.EXIT_CODES} reason
	 */
	exitAdapter(reason){
		if(reason == null){
			reason = utils.ExitCodes.NO_ERROR;
		}
		
		// Terminate Adapter
		if (typeof this.terminate === "function") {
			this.terminate(reason);
		} else {
			process.exit(reason);
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
				this.log.error("Error getting settings-object: " + (err || "Object not found"));
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
	 * Loops through defined array of states and sets or creates theom from retrieved API data
	 */
	setStatesOrCreate(strParentObjectID, obj, arrStatesDefinition){
		for (const [stateSourceObject, stateDefinition] of Object.entries(arrStatesDefinition)) {
			if(!(stateSourceObject in obj) && !("def" in stateDefinition)){
				this.log.warn("There is not a property \""+ stateSourceObject + "\"");
				continue;
			}

			const stateID = strParentObjectID + "." + stateDefinition.name;
			let stateValue = null;
			if(stateSourceObject in obj){
				stateValue = obj[stateSourceObject];
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

	/**
	 * Sets and optionally creates a state if it doies not exists
	 * @param {string} stateID
	 * @param {string | boolean | number | null} stateValue
	 */
	setStateOrCreate(stateID, stateValue, options){

		if(!options || !options.common || !options.common.type){
			this.log.error("No type defined for object " + stateID + "!");
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

			this.log.debug("Download " + url + " -> " + filename);

			axios({
				method: "get",
				url: url,
				responseType: "arraybuffer", // Ensures we handle the data as a stream
				headers: {
					"Authorization": "Bearer " + token,
				}
			})
				.then((response) => {

					if (!response.data) {
						reject(new Error("Response does not contain data"));
					}

					this.log.debug("Download successfull");

					const buffer = Buffer.from(response.data, "binary");
					this.writeFileAsync(this.name, filename, buffer)
						.then(() => {
							resolve("/" + path.join(this.name, filename));
						});
				})
				.catch((error) => {
					reject(new Error("Failed to download image: " + error.message));
				});
		});
	}

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