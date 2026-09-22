/** Agent 定时任务相关类型 */

export type ScheduleFrequency = "repeat" | "once";
export type TriggerType = "daily" | "interval";

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  /** daily=定时执行（每天 hour:minute）；interval=周期执行（每隔 hour 小时 minute 分钟） */
  trigger_type: TriggerType;
  hour: number;
  minute: number;
  frequency: ScheduleFrequency;
  /** 仅工作日执行（周一~周五，跳过周六周日） */
  weekdays_only: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_status: string | null; // running / success / error
  last_result: string | null;
  next_run_at: string | null;
}

export interface ScheduleListResponse {
  data: ScheduledTask[];
  total: number;
}

export interface SchedulePayload {
  name: string;
  prompt: string;
  trigger_type: TriggerType;
  hour: number;
  minute: number;
  frequency: ScheduleFrequency;
  weekdays_only: boolean;
}
