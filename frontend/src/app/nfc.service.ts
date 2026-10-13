import { DutyLogService } from './duty-log.service';

export type { DutyLogAction, DutyLogEntry, DutyLogRequest } from './duty-log.service';
export { DutyLogService } from './duty-log.service';

export class NfcService extends DutyLogService {}
