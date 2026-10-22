import { invoke as invokeTauri } from '@tauri-apps/api/core';
import type { Transcript } from '@/types';

/**
 * Fetch every transcript segment for a meeting (bypassing pagination), used
 * whenever the full transcript text is needed to (re)generate a summary.
 */
export async function fetchAllTranscriptsForMeeting(meetingId: string): Promise<Transcript[]> {
  const firstPage = await invokeTauri('api_get_meeting_transcripts', {
    meetingId,
    limit: 1,
    offset: 0,
  }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

  const totalCount = firstPage.total_count;
  if (totalCount === 0) {
    return [];
  }

  const allData = await invokeTauri('api_get_meeting_transcripts', {
    meetingId,
    limit: totalCount,
    offset: 0,
  }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

  return allData.transcripts;
}

/** Build the flattened transcript text (with timestamps) sent to the summary engine. */
export function buildSummaryTranscriptPayload(allTranscripts: Transcript[]) {
  const formatTime = (seconds: number | undefined, fallbackTimestamp: string): string => {
    if (seconds === undefined) {
      return fallbackTimestamp;
    }
    const totalSecs = Math.floor(seconds);
    return `[${Math.floor(totalSecs / 60).toString().padStart(2, '0')}:${(totalSecs % 60).toString().padStart(2, '0')}]`;
  };

  return {
    transcriptText: allTranscripts
      .map((transcript) => `${formatTime(transcript.audio_start_time, transcript.timestamp)} ${transcript.text}`)
      .join('\n'),
    transcriptTexts: allTranscripts.map((transcript) => transcript.text),
  };
}
