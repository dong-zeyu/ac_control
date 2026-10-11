import { API } from 'homebridge';
import { AehaAirConditionerPlatform, PLATFORM_NAME } from './platform.js';

export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, AehaAirConditionerPlatform);
};
