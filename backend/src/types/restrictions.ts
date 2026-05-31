export interface RestrictionWindow {
  id?: number;
  name?: string;
  start_time?: string;
  end_time?: string;
  reason?: string;
}

export interface RestrictionState {
  windows: RestrictionWindow[];
  active: RestrictionWindow | null;
}
