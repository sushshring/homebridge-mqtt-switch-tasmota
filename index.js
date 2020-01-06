// Sonoff-Tasmota Switch/Outlet Accessory plugin for HomeBridge
// Jaromir Kopp @MacWyznawca

'use strict';

var Service, Characteristic;
var mqtt = require("mqtt");

module.exports = function(homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;

	homebridge.registerAccessory("homebridge-mqtt-threestate-light-tasmota", "mqtt-threestate-light-tasmota", MqttThreeStateLightTasmotaAccessory);
}

const COLORS = {
	WHITE: 'white',
	DAYLIGHT: 'daylight',
	YELLOW: 'yellow',
	OFF: 'off',
}

const TYPE = {
	OUTLET: 'outlet',
	SWITCH: 'switch',
	LIGHTBULB: 'lightbulb',
}

function MqttThreeStateLightTasmotaAccessory(log, config) {
	this.log = log;

	this.url = config["url"];
	this.publish_options = {
		qos: ((config["qos"] !== undefined) ? config["qos"] : 0)
	};

	this.client_Id = 'mqttjs_' + Math.random().toString(16).substr(2, 8);
	this.options = {
		keepalive: 10,
		clientId: this.client_Id,
		protocolId: 'MQTT',
		protocolVersion: 4,
		clean: true,
		reconnectPeriod: 1000,
		connectTimeout: 30 * 1000,
		will: {
			topic: 'WillMsg',
			payload: 'Connection Closed abnormally..!',
			qos: 0,
			retain: false
		},
		username: config["username"],
		password: config["password"],
		rejectUnauthorized: false
	};

	this.topicStatusGet = config["topics"].statusGet;
	this.topicStatusSet = config["topics"].statusSet;
	this.topicColorGet = config["topics"].colorGet || "";
	this.topicColorSet = config["topics"].colorSet || "";
	this.topicsStateGet = (config["topics"].stateGet !== undefined) ? config["topics"].stateGet : "";

	this.onValue = (config["onValue"] !== undefined) ? config["onValue"] : "ON";
	this.offValue = (config["offValue"] !== undefined) ? config["offValue"] : "OFF";

	let powerVal = this.topicStatusSet.split("/");
	this.powerValue = powerVal[powerVal.length-1]
	this.log('Nazwa do RESULT ',this.powerValue);

	if (config["activityTopic"] !== undefined && config["activityParameter"] !== undefined) {
		this.activityTopic = config["activityTopic"];
		this.activityParameter = config["activityParameter"];
	} else {
		this.activityTopic = "";
		this.activityParameter = "";
	}

	this.name = config["name"] || "Sonoff";
	this.manufacturer = config['manufacturer'] || "ITEAD";
	this.model = config['model'] || "Sonoff";
	this.serialNumberMAC = config['serialNumberMAC'] || "";

	this.outlet = getType(config["switchType"])

	this.switchStatus = false;
	this.colorStatus = COLORS.WHITE;
	this.hue = 50;

	if (this.outlet == TYPE.OUTLET) {
		this.service = new Service.Outlet(this.name);
		this.service
			.getCharacteristic(Characteristic.OutletInUse)
			.on('get', this.getOutletUse.bind(this));
	} else if (this.outlet == TYPE.SWITCH) {
		this.service = new Service.Switch(this.name);
	} else if (this.outlet == TYPE.LIGHTBULB) {
		this.service = new Service.Lightbulb(this.name);
		this.service.getCharacteristic(Characteristic.Hue)
			.on('get', this.getHue.bind(this))
			.on('set', this.setHue.bind(this));
		this.service.getCharacteristic(Characteristic.Saturation)
			.on('get', this.getSaturation.bind(this))
			.on('set', this.setSaturation.bind(this));
	} else {
		throw new Error('Illegal type');
	}

	this.service
		.getCharacteristic(Characteristic.On)
		.on('get', this.getStatus.bind(this))
		.on('set', this.setStatus.bind(this));

	if (this.activityTopic !== "") {
		this.service.addOptionalCharacteristic(Characteristic.StatusActive);
		this.service
			.getCharacteristic(Characteristic.StatusActive)
			.on('get', this.getStatusActive.bind(this));
	}


	this.client = mqtt.connect(this.url, this.options);
	var that = this;
	this.client.on('error', function() {
		that.log('Error event on MQTT');
	});

	this.client.on('connect', function() {
		if (config["startCmd"] !== undefined && config["startParameter"] !== undefined) {
			that.client.publish(config["startCmd"], config["startParameter"]);
		}
	});

	this.client.on('message', function(topic, message) {
		if (topic == that.topicStatusGet) {
			try {
				// In the event that the user has a DUAL the topicStatusGet will return for POWER1 or POWER2 in the JSON.  
				// We need to coordinate which accessory is actually being reported and only take that POWER data.  
				// This assumes that the Sonoff single will return the value { "POWER" : "ON" }
				var data = JSON.parse(message);
				var status = data.POWER;
				if (data.hasOwnProperty(that.powerValue))
					status = data[that.powerValue];
				if (status !== undefined) {
					that.switchStatus = (status == that.onValue);
				  	that.log(that.name, "(",that.powerValue,") - Power from Status", status); //TEST ONLY
				}
			} catch (e) {
				var status = message.toString();

				that.switchStatus = (status == that.onValue);
			}
			that.service.getCharacteristic(Characteristic.On).setValue(that.switchStatus, undefined, 'fromSetValue');
		}

		if (topic == that.topicsStateGet) {
			try {
				var data = JSON.parse(message);
				if (data.hasOwnProperty(that.powerValue)) {
					var status = data[that.powerValue];
					that.log(that.name, "(",that.powerValue,") - Power from State", status); //TEST ONLY
					that.switchStatus = (status == that.onValue);
					that.service.getCharacteristic(Characteristic.On).setValue(that.switchStatus, undefined, '');
				}
			} catch (e) {}
		} else if (topic == that.activityTopic) {
			var status = message.toString();
			that.activeStat = (status == that.activityParameter);
			that.service.setCharacteristic(Characteristic.StatusActive, that.activeStat);
		} else if (topic == that.topicColorGet) {
			try {
				var data = JSON.parse(message);
				if (data.hasOwnProperty('color')) {
					var color = data['color'];
					that.colorStatus = getColorFromStatus(color);
					that.service.setCharacteristic(Characteristic.Hue, getSaturationFromColor(that.colorStatus));
				}
			} catch (e) {}
		}
	});
	this.client.subscribe(this.topicStatusGet);
	if (this.topicsStateGet !== "") {
		this.client.subscribe(this.topicsStateGet);
	}
	if (this.topicColorGet !== "") {
		this.client.subscribe(this.topicColorGet);
	}
	if (this.topicColorSet !== "") {
		this.client.subscribe(this.topicColorSet);
	}
	if (this.activityTopic !== "") {
		this.client.subscribe(this.activityTopic);
	}
}

function getColorFromStatus(status) {
	switch(status) {
		case 'white':
			return COLORS.WHITE;
		case 'daylight':
			return COLORS.DAYLIGHT;
		case 'yellow':
			return COLORS.YELLOW;
		case 'off':
			return COLORS.OFF;
		default:
			return COLORS.WHITE;
	}
}

function getSaturationFromColor(color) {
	switch(color) {
		case COLORS.WHITE:
			return 0;
		case COLORS.DAYLIGHT:
			return 35;
		case COLORS.YELLOW:
			return 78;
		default:
			return 0;
	}
}

function getColorFromSaturation(saturation) {
	if (saturation >= 0 && saturation < 33) {
		return COLORS.WHITE;
	}
	if (saturation >= 33 && saturation < 66) {
		return COLORS.DAYLIGHT;
	}
	return COLORS.YELLOW;
}

function getType(type) {
	switch(type) {
		case 'outlet':
			return TYPE.OUTLET;
		case 'switch':
			return TYPE.SWITCH;
		case 'lightbulb':
			return TYPE.LIGHTBULB;
		default:
			return TYPE.OUTLET;
	}
}

MqttThreeStateLightTasmotaAccessory.prototype.getStatus = function(callback) {
	if (this.activeStat) {
		this.log("Power state for '%s' is %s", this.name, this.switchStatus);
		callback(null, this.switchStatus);
	} else {
		this.log("'%s' is offline", this.name);
		callback('No Response');
	}
}

MqttThreeStateLightTasmotaAccessory.prototype.setStatus = function(status, callback, context) {
	if (context !== 'fromSetValue') {
		this.switchStatus = status;
		this.log("Set power state on '%s' to %s", this.name, status);
		this.client.publish(this.topicStatusSet, status ? this.onValue : this.offValue, this.publish_options);
	}
	callback();
}

// Returns saturation to the caller
MqttThreeStateLightTasmotaAccessory.prototype.getSaturation = function(callback) {
	if (this.colorStatus) {
		this.log("Color state for '%s' is %s", this.name, this.colorStatus);
		callback(null, getSaturationFromColor(this.colorStatus));
	} else {
		this.log("'%s' is offline", this.name);
		callback('No Response');
	}
}

// Sets the color state based on Hue
MqttThreeStateLightTasmotaAccessory.prototype.setSaturation = function(saturation, callback, context) {
	if (context !== 'fromSetValue') {
		this.colorStatus = getColorFromSaturation(saturation);
		this.log("Set color state on '%s' to %s", this.name, saturation);
		this.client.publish(this.topicColorSet + '/' + this.colorStatus, this.colorStatus, this.publish_options);
	}
	callback();
}
// Returns a Hue to the caller
MqttThreeStateLightTasmotaAccessory.prototype.getHue = function(callback) {
	if (this.hue) {
		this.log("Responding with hue", this.hue);
		callback(null, this.hue);
	} else {
		this.log("'%s' is offline", this.name);
		callback('No Response');
	}
}

// Sets the color state based on Hue
MqttThreeStateLightTasmotaAccessory.prototype.setHue = function(hue, callback, context) {
	if (context !== 'fromSetValue') {
		this.log("Hue: ", hue);
		this.hue = hue || 50;
	}
	callback();
}

MqttThreeStateLightTasmotaAccessory.prototype.getStatusActive = function(callback) {
	this.log(this.name, " -  Activity Set : ", this.activeStat);
	callback(null, this.activeStat);
}

MqttThreeStateLightTasmotaAccessory.prototype.getOutletUse = function(callback) {
	callback(null, true); // If configured for outlet - always in use (for now)
}

MqttThreeStateLightTasmotaAccessory.prototype.getServices = function() {

	var informationService = new Service.AccessoryInformation();

	informationService
		.setCharacteristic(Characteristic.Name, this.name)
		.setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
		.setCharacteristic(Characteristic.Model, this.model)
		.setCharacteristic(Characteristic.SerialNumber, this.serialNumberMAC);

	return [informationService, this.service];
}
