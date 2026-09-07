import { Env, Provenance } from "../models/types";
import { unavailable } from "../utils/integrity";

export interface CouncilMeeting {
  meeting_id: string;
  term: number;
  session_period: number;
  meeting_name: string;
  meeting_date: string;
  agenda: string;
}

export interface CouncilInterpellation {
  record_id: string;
  term: number;
  session_period: number;
  legislator_name: string;
  topic: string;
  content_summary: string;
  date: string;
}

export interface CouncilData {
  meetings: CouncilMeeting[];
  interpellations: CouncilInterpellation[];
}

/** Legacy adapter retained only to make old imports fail closed. */
export async function fetchCouncilData(_env: Env): Promise<{ data: CouncilData; provenance: Provenance }> {
  return unavailable("舊議會 snapshot adapter");
}
