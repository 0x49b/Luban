// import store from '../../store';
import request from 'superagent';
import { isEqual, isNil } from 'lodash';
import type SocketServer from '../../lib/SocketManager';
import logger from '../../lib/logger';
import workerManager from '../task-manager/workerManager';
import DataStorage from '../../DataStorage';
import { HEAD_PRINTING, HEAD_LASER, HEAD_CNC, MACHINE_SERIES,
    SINGLE_EXTRUDER_TOOLHEAD_FOR_SM2,
    STANDARD_CNC_TOOLHEAD_FOR_SM2,
    LEVEL_ONE_POWER_LASER_FOR_SM2,
    LEVEL_TWO_POWER_LASER_FOR_SM2,
    CONNECTION_TYPE_WIFI
} from '../../constants';
import { valueOf } from '../../lib/contants-utils';
import wifiServerManager from './WifiServerManager';

let waitConfirm: boolean;
const log = logger('lib:SocketHttp');


const isJSON = (str: string) => {
    if (typeof str === 'string') {
        try {
            const obj = JSON.parse(str);
            if (typeof obj === 'object' && obj) {
                return true;
            } else {
                return false;
            }
        } catch (e) {
            return false;
        }
    }
    return false;
};

const _getResult = (err, res) => {
    if (err) {
        if (res && isJSON(res.text) && JSON.parse(res.text).code === 202) {
            return {
                msg: err.message,
                code: 202,
                text: res && res.text,
                data: res && res.body
            };
        } else if (res && isJSON(res.text) && JSON.parse(res.text).code === 203) {
            return {
                msg: err.message,
                code: 203,
                text: res && res.text,
                data: res && res.body
            };
        } else {
            return {
                msg: err.message,
                code: res && res.status,
                text: res && res.text,
                data: res && res.body
            };
        }
    }
    const code = res.status;
    if (code !== 200 && code !== 204 && code !== 203) {
        return {
            code,
            msg: res && res.text
        };
    }
    return {
        code,
        msg: '',
        data: res.body,
        text: res.text
    };
};
// let timeoutHandle = null;
let intervalHandle = null;

export type EventOptions = {
    eventName: string,
    host?: string,
    token?: string,
    gcode?: string,
    x?: number,
    y?: number,
    feedRate?: number,
    gcodePath?: string,
    value?: number,
    enable?: boolean,
    workSpeedFactor?: number,
    laserPower?: number,
    nozzleTemperatureValue?: number,
    heatedBedTemperatureValue?: number,
    zOffset?: number,
};
export type StateOptions = {
    headType?: string,
    toolHead?: string,
    series?: string
};

export type GcodeResult = {
    text?: string,
    data?: any,
    msg?: string,
    code?: number
};
/**
 * A singleton to manage devices connection.
 */
class SocketHttp {
    private isGcodeExecuting: boolean = false;

    private gcodeInfos = [];

    private socket: SocketServer = null;

    private host: string = '';

    private token: string = '';

    private state: StateOptions = {};

    private heartBeatWorker = null;

    private moduleSettings = null;

    private getLaserMaterialThicknessReq = null;

    public onConnection = (socket: SocketServer) => {
        wifiServerManager.onConnection(socket);
        this.heartBeatWorker && this.heartBeatWorker.terminate();
    }

    public onDisconnection = (socket: SocketServer) => {
        wifiServerManager.onDisconnection(socket);
    }

    public refreshDevices = () => {
        wifiServerManager.refreshDevices();
    }

    public connectionOpen = (socket: SocketServer, options: EventOptions) => {
        const { host, token } = options;
        this.host = host;
        this.token = token;
        this.socket = socket;
        log.debug(`wifi host="${this.host}" : token=${this.token}`);
        const api = `${this.host}/api/v1/connect`;
        intervalHandle = setInterval(this.getEnclosureStatus, 1000);
        request
            .post(api)
            .timeout(3000)
            .send(token ? `token=${this.token}` : '')
            .end((err, res) => {
                if (res?.body?.token) {
                    this.token = res.body.token;
                }
                const result = _getResult(err, res);
                const { data } = result;
                if (data) {
                    const { series } = data;
                    const seriesValue = valueOf(MACHINE_SERIES, 'alias', series);
                    this.state.series = seriesValue ? seriesValue.value : null;

                    let headType = data.headType;
                    let toolHead: string;
                    switch (data.headType) {
                        case 1:
                            headType = HEAD_PRINTING;
                            toolHead = SINGLE_EXTRUDER_TOOLHEAD_FOR_SM2;
                            break;
                        case 2:
                            headType = HEAD_CNC;
                            toolHead = STANDARD_CNC_TOOLHEAD_FOR_SM2;
                            break;
                        case 3:
                            headType = HEAD_LASER;
                            toolHead = LEVEL_ONE_POWER_LASER_FOR_SM2;
                            break;
                        case 4:
                            headType = HEAD_LASER;
                            toolHead = LEVEL_TWO_POWER_LASER_FOR_SM2;
                            break;
                        default:
                            headType = data.headType;
                            toolHead = undefined;
                    }
                    this.state.headType = headType;
                    this.state.toolHead = toolHead;
                }
                this.socket && this.socket.emit('connection:open', result);
            });
    };

    public connectionClose = (socket: SocketServer, options: EventOptions) => {
        const { eventName } = options;
        const api = `${this.host}/api/v1/disconnect`;
        request
            .post(api)
            .timeout(3000)
            .send(`token=${this.token}`)
            .end((err, res) => {
                socket && socket.emit(eventName, _getResult(err, res));
            });
        this.host = '';
        this.token = '';
        this.heartBeatWorker && this.heartBeatWorker.terminate();
        clearInterval(intervalHandle);
    };

    public startGcode = (options: EventOptions) => {
        const { eventName } = options;
        const api = `${this.host}/api/v1/start_print`;
        request
            .post(api)
            .timeout(120000)
            .send(`token=${this.token}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res) || {});
            });
    }

    public resumeGcode = (options: EventOptions) => {
        const { eventName } = options;
        const api = `${this.host}/api/v1/resume_print`;
        request
            .post(api)
            .timeout(120000)
            .send(`token=${this.token}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public pauseGcode = (options: EventOptions) => {
        const { eventName } = options;
        const api = `${this.host}/api/v1/pause_print`;
        request
            .post(api)
            .timeout(120000)
            .send(`token=${this.token}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public stopGcode = (options: EventOptions) => {
        const { eventName } = options;
        const api = `${this.host}/api/v1/stop_print`;
        request
            .post(api)
            .timeout(120000)
            .send(`token=${this.token}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public executeGcode = (options: EventOptions, callback) => {
        return new Promise(resolve => {
            const { gcode } = options;
            const split = gcode.split('\n');
            this.gcodeInfos.push({
                gcodes: split,
                callback: (result) => {
                    callback && callback(result);
                    resolve(result);
                }
            });
            this.startExecuteGcode();
        });
    };

    public startExecuteGcode = async () => {
        if (this.isGcodeExecuting) {
            return;
        }
        this.isGcodeExecuting = true;
        while (this.gcodeInfos.length > 0) {
            const splice = this.gcodeInfos.splice(0, 1)[0];
            const result = [];
            for (const gcode of splice.gcodes) {
                const { text } = await this._executeGcode(gcode) as GcodeResult;
                result.push(gcode);
                if (text) {
                    result.push(text);
                }
            }
            splice.callback && splice.callback(result);
            this.socket && this.socket.emit('connection:executeGcode', result);
        }
        this.isGcodeExecuting = false;
    };

    public _executeGcode = (gcode: string) => {
        const api = `${this.host}/api/v1/execute_code`;
        return new Promise((resolve) => {
            const req = request.post(api);
            req.timeout(300000)
                .send(`token=${this.token}`)
                .send(`code=${gcode}`)
                // .send(formData)
                .end((err, res) => {
                    const { data, text } = _getResult(err, res);
                    resolve({ data, text });
                });
        });
    };

    public startHeartbeat = () => {
        waitConfirm = true;
        this.heartBeatWorker = workerManager.heartBeat([{
            host: this.host,
            token: this.token
        }], (result: any) => {
            if (result.status === 'offline') {
                this.socket && this.socket.emit('connection:close');
                return;
            }
            const { data, code } = _getResult(null, result.res);
            // No Content
            if (Object.keys(data).length === 0 || code === 204) {
                return;
            }
            const state = {
                ...data,
                ...this.state,
                isHomed: data?.homed,
                status: data.status.toLowerCase(),
                airPurifier: !isNil(data.airPurifierSwitch),
                pos: {
                    x: data.x,
                    y: data.y,
                    z: data.z,
                    b: data.b,
                    isFourAxis: !isNil(data.b)
                },
                originOffset: {
                    x: data.offsetX,
                    y: data.offsetY,
                    z: data.offsetZ,
                }
            };

            if (waitConfirm) {
                waitConfirm = false;
                this.socket && this.socket.emit('connection:connected', {
                    state,
                    err: state?.err,
                    type: CONNECTION_TYPE_WIFI
                });
            } else {
                this.socket && this.socket.emit('Marlin:state', {
                    state,
                    type: CONNECTION_TYPE_WIFI
                });
            }
        });
    }

    public uploadGcodeFile = (gcodeFilePath:string, type:string, callback) => {
        const api = `${this.host}/api/v1/prepare_print`;
        if (type === HEAD_PRINTING) {
            type = '3DP';
        } else if (type === HEAD_LASER) {
            type = 'Laser';
        } else if (type === HEAD_CNC) {
            type = 'CNC';
        }
        request
            .post(api)
            .field('token', this.token)
            .field('type', type)
            .attach('file', gcodeFilePath)
            .end((err, res) => {
                const { msg, data } = _getResult(err, res);
                if (callback) {
                    callback(msg, data);
                }
            });
    };

    public abortLaserMaterialThickness = (options: EventOptions) => {
        this.getLaserMaterialThicknessReq && this.getLaserMaterialThicknessReq.abort();
    };

    public getLaserMaterialThickness = (options: EventOptions) => {
        const { x, y, feedRate, eventName } = options;
        const api = `${this.host}/api/request_Laser_Material_Thickness?token=${this.token}&x=${x}&y=${y}&feedRate=${feedRate}`;
        const req = request.get(api);
        this.getLaserMaterialThicknessReq = req;
        req.end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public getGcodeFile = (options: EventOptions) => {
        const { eventName } = options;

        const api = `${this.host}/api/v1/print_file?token=${this.token}`;
        request
            .get(api)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, {
                    msg: err?.message,
                    text: res.text
                });
            });
    };

    public uploadFile = (options: EventOptions) => {
        const { gcodePath, eventName } = options;
        const api = `${this.host}/api/v1/upload`;
        request
            .post(api)
            .timeout(300000)
            .field('token', this.token)
            .attach('file', DataStorage.tmpDir + gcodePath)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public updateNozzleTemperature = (options: EventOptions) => {
        const { nozzleTemperatureValue, eventName } = options;
        const api = `${this.host}/api/v1/override_nozzle_temperature`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .send(`nozzleTemp=${nozzleTemperatureValue}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public updateBedTemperature = (options: EventOptions) => {
        const { heatedBedTemperatureValue, eventName } = options;
        const api = `${this.host}/api/v1/override_bed_temperature`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .send(`heatedBedTemp=${heatedBedTemperatureValue}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public updateZOffset = (options: EventOptions) => {
        const { zOffset, eventName } = options;
        const api = `${this.host}/api/v1/override_z_offset`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .send(`zOffset=${zOffset}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public loadFilament = (options: EventOptions) => {
        const { eventName } = options;
        const api = `${this.host}/api/v1/filament_load`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public unloadFilament = (options: EventOptions) => {
        const { eventName } = options;
        const api = `${this.host}/api/v1/filament_unload`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public updateWorkSpeedFactor = (options: EventOptions) => {
        const { eventName, workSpeedFactor } = options;
        const api = `${this.host}/api/v1/override_work_speed`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .send(`workSpeed=${workSpeedFactor}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public updateLaserPower = (options: EventOptions) => {
        const { eventName, laserPower } = options;
        const api = `${this.host}/api/v1/override_laser_power`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .send(`laserPower=${laserPower}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public getEnclosureStatus = () => {
        const api = `${this.host}/api/v1/enclosure?token=${this.token}`;
        request
            .get(api)
            .end((err, res) => {
                const currentModuleStatus = _getResult(err, res)?.data;
                if (!isEqual(this.moduleSettings, currentModuleStatus)) {
                    this.moduleSettings = currentModuleStatus;
                    this.socket && this.socket.emit('Marlin:settings', {
                        settings: {
                            enclosureDoorDetection: currentModuleStatus?.isDoorEnabled,
                            enclosureOnline: currentModuleStatus?.isReady,
                            enclosureFan: currentModuleStatus?.fan,
                            enclosureLight: currentModuleStatus?.led,
                        }
                    });
                }
            });
    };

    public setEnclosureLight = (options: EventOptions) => {
        const { eventName, value } = options;
        const api = `${this.host}/api/v1/enclosure`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .send(`led=${value}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

    public setEnclosureFan = (options: EventOptions) => {
        const { eventName, value } = options;
        const api = `${this.host}/api/v1/enclosure`;
        request
            .post(api)
            .send(`token=${this.token}`)
            .send(`fan=${value}`)
            .end((err, res) => {
                this.socket && this.socket.emit(eventName, _getResult(err, res));
            });
    };

   public setDoorDetection = (options: EventOptions) => {
       const { eventName, enable } = options;
       const api = `${this.host}/api/v1/enclosure`;
       request
           .post(api)
           .send(`token=${this.token}`)
           .send(`isDoorEnabled=${enable}`)
           .end((err, res) => {
               this.socket && this.socket.emit(eventName, _getResult(err, res));
           });
   };

   public setFilterSwitch = (options: EventOptions) => {
       const { eventName, enable } = options;
       const api = `${this.host}/api/v1/air_purifier_switch`;
       request
           .post(api)
           .send(`token=${this.token}`)
           .send(`switch=${enable}`)
           .end((err, res) => {
               this.socket && this.socket.emit(eventName, _getResult(err, res));
           });
   };

   public setFilterWorkSpeed = (options: EventOptions) => {
       const { eventName, value } = options;
       const api = `${this.host}/api/v1/air_purifier_fan_speed`;
       request
           .post(api)
           .send(`token=${this.token}`)
           .send(`fan_speed=${value}`)
           .end((err, res) => {
               this.socket && this.socket.emit(eventName, _getResult(err, res));
           });
   };
}

const socketHttp = new SocketHttp();

export default socketHttp;
