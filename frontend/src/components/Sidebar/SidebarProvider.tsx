'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useConfig } from '@/contexts/ConfigContext';
import type { SummaryProcessResponse } from '@/types';
import { fetchAllTranscriptsForMeeting, buildSummaryTranscriptPayload } from '@/lib/summary-transcript-payload';
import {
  readMeetingSummaryLanguage,
  readCachedDetectedSummaryLanguage,
} from '@/lib/summary-language-preferences';



interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
}

/** Meeting-level summary lifecycle, derived from the summary_processes row (or its absence). */
export type MeetingSummaryStatus = 'pending' | 'completed' | 'failed' | 'cancelled' | null;

export interface CurrentMeeting {
  id: string;
  title: string;
  createdAt?: string;
  durationSeconds?: number;
  summaryStatus?: MeetingSummaryStatus;
}

// Search result type for transcript search
interface TranscriptSearchResult {
  id: string;
  title: string;
  matchContext: string;
  timestamp: string;
}

interface SummaryPoll {
  processId: string;
  timer: NodeJS.Timeout;
  inFlight: boolean;
}

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  toggleCollapse: () => void;
  meetings: CurrentMeeting[];
  setMeetings: (meetings: CurrentMeeting[]) => void;
  isMeetingActive: boolean;
  setIsMeetingActive: (active: boolean) => void;
  handleRecordingToggle: () => void;
  searchTranscripts: (query: string) => Promise<void>;
  searchResults: TranscriptSearchResult[];
  isSearching: boolean;
  setServerAddress: (address: string) => void;
  serverAddress: string;
  transcriptServerAddress: string;
  setTranscriptServerAddress: (address: string) => void;
  // Summary polling management
  startSummaryPolling: (
    meetingId: string,
    processId: string,
    onUpdate: (result: SummaryProcessResponse) => void | Promise<void>
  ) => void;
  stopSummaryPolling: (meetingId: string, processId?: string) => void;
  // Refetch meetings from backend
  refetchMeetings: () => Promise<void>;

}

const SidebarContext = createContext<SidebarContextType | null>(null);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [currentMeeting, setCurrentMeeting] = useState<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
  const [isCollapsed, setIsCollapsed] = useState(true);
  const [meetings, setMeetings] = useState<CurrentMeeting[]>([]);
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [serverAddress, setServerAddress] = useState('');
  const [transcriptServerAddress, setTranscriptServerAddress] = useState('');
  const summaryPollsRef = React.useRef(new Map<string, SummaryPoll>());

  // Use recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();
  const { isAutoSummary, modelConfig, isModelConfigLoading } = useConfig();

  const pathname = usePathname();
  const router = useRouter();

  // Extract fetchMeetings as a reusable function
  const fetchMeetings = React.useCallback(async () => {
    if (serverAddress) {
      try {
        const meetings = await invoke('api_get_meetings') as Array<{
          id: string;
          title: string;
          created_at?: string;
          durationSeconds?: number;
          summaryStatus?: MeetingSummaryStatus;
        }>;
        const transformedMeetings: CurrentMeeting[] = meetings.map((meeting) => ({
          id: meeting.id,
          title: meeting.title,
          createdAt: meeting.created_at,
          durationSeconds: meeting.durationSeconds,
          summaryStatus: meeting.summaryStatus ?? null,
        }));
        setMeetings(transformedMeetings);
        Analytics.trackBackendConnection(true);
      } catch (error) {
        console.error('Error fetching meetings:', error);
        setMeetings([]);
        Analytics.trackBackendConnection(false, error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }, [serverAddress]);

  useEffect(() => {
    fetchMeetings();
  }, [serverAddress, fetchMeetings]);

  useEffect(() => {
    const fetchSettings = async () => {
      setServerAddress('http://localhost:5167');
      setTranscriptServerAddress('http://127.0.0.1:8178/stream');
    };
    fetchSettings();
  }, []);

  const baseItems: SidebarItem[] = [
    {
      id: 'meetings',
      title: 'Meeting Notes',
      type: 'folder' as const,
      children: [
        ...meetings.map(meeting => ({ id: meeting.id, title: meeting.title, type: 'file' as const }))
      ]
    },
  ];


  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  // Update current meeting when on home page
  useEffect(() => {
    if (pathname === '/') {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
    }
    setSidebarItems(baseItems);
  }, [pathname]);

  // Update sidebar items when meetings change
  useEffect(() => {
    setSidebarItems(baseItems);
  }, [meetings]);

  // Function to handle recording toggle from sidebar
  const handleRecordingToggle = () => {
    if (!isRecording) {
      // Check if already on home page
      if (pathname === '/') {
        // Already on home - trigger recording directly via custom event
        console.log('Triggering recording from sidebar (already on home page)');
        window.dispatchEvent(new CustomEvent('start-recording-from-sidebar'));
      } else {
        // Not on home - navigate and use auto-start mechanism
        console.log('Navigating to home page with auto-start flag');
        sessionStorage.setItem('autoStartRecording', 'true');
        router.push('/');
      }

      // Track recording initiation from sidebar
      Analytics.trackButtonClick('start_recording', 'sidebar');
    }
    // The actual recording start/stop is handled in the Home component
  };

  // Function to search through meeting transcripts
  const searchTranscripts = async (query: string) => {
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      setIsSearching(true);


      const results = await invoke('api_search_transcripts', { query }) as TranscriptSearchResult[];
      setSearchResults(results);
    } catch (error) {
      console.error('Error searching transcripts:', error);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Summary polling management
  const stopSummaryPolling = React.useCallback((meetingId: string, processId?: string) => {
    const poll = summaryPollsRef.current.get(meetingId);
    if (!poll || (processId && poll.processId !== processId)) {
      return;
    }
    clearInterval(poll.timer);
    summaryPollsRef.current.delete(meetingId);
  }, []);

  const startSummaryPolling = React.useCallback((
    meetingId: string,
    processId: string,
    onUpdate: (result: SummaryProcessResponse) => void | Promise<void>
  ) => {
    stopSummaryPolling(meetingId);
    let pollCount = 0;
    const maxPolls = 200;
    const poll = async () => {
      const entry = summaryPollsRef.current.get(meetingId);
      if (!entry || entry.processId !== processId || entry.inFlight) {
        return;
      }
      entry.inFlight = true;
      try {
        pollCount += 1;
        if (pollCount >= maxPolls) {
          await onUpdate({
            status: 'error',
            meetingName: null,
            meeting_id: meetingId,
            start: processId,
            end: null,
            data: null,
            error: 'Summary generation timed out after 15 minutes. Please try again or check your model configuration.',
          });
          if (summaryPollsRef.current.get(meetingId) === entry) {
            stopSummaryPolling(meetingId, processId);
          }
          return;
        }

        const result = await invoke<SummaryProcessResponse>('api_get_summary', { meetingId });
        const current = summaryPollsRef.current.get(meetingId);
        if (current !== entry || result.start !== processId) {
          return;
        }
        await onUpdate(result);
        if (summaryPollsRef.current.get(meetingId) !== entry) return;
        if (
          result.status === 'completed'
          || result.status === 'error'
          || result.status === 'failed'
          || result.status === 'cancelled'
          || (result.status === 'idle' && pollCount > 1)
        ) {
          stopSummaryPolling(meetingId, processId);
        }
      } catch (error) {
        const current = summaryPollsRef.current.get(meetingId);
        if (current !== entry) {
          return;
        }
        try {
          await onUpdate({
            status: 'error',
            meetingName: null,
            meeting_id: meetingId,
            start: processId,
            end: null,
            data: null,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        } catch (callbackError) {
          console.error('Failed to handle summary polling error:', callbackError);
        } finally {
          if (summaryPollsRef.current.get(meetingId) === entry) {
            stopSummaryPolling(meetingId, processId);
          }
        }
      } finally {
        const current = summaryPollsRef.current.get(meetingId);
        if (current === entry) {
          current.inFlight = false;
        }
      }
    };

    const timer = setInterval(() => void poll(), 5000);
    summaryPollsRef.current.set(meetingId, { processId, timer, inFlight: false });
  }, [stopSummaryPolling]);

  useEffect(() => () => {
    summaryPollsRef.current.forEach(({ timer }) => clearInterval(timer));
    summaryPollsRef.current.clear();
  }, []);

  // Resume interrupted summary jobs after an app restart/crash.
  //
  // A meeting's summary_processes row is left in 'pending' status only while a
  // generation is actively running (see create_or_reset_process /
  // update_process_completed|failed|cancelled in the Rust summary repository).
  // If the app is closed or crashes mid-generation, that row survives in SQLite
  // as an orphaned 'pending' with no in-memory poller left to finish it. On the
  // next launch we detect those and restart generation for them exactly once,
  // reusing api_process_transcript's own idempotent compare-and-set so this can
  // never race into a duplicate summary or a duplicate meeting.
  const hasResumedPendingSummariesRef = React.useRef(false);
  useEffect(() => {
    if (hasResumedPendingSummariesRef.current) return;
    if (meetings.length === 0) return;
    if (isModelConfigLoading) return;
    hasResumedPendingSummariesRef.current = true;

    if (!isAutoSummary) return;
    if (!modelConfig.provider || !modelConfig.model) return;

    const pendingMeetings = meetings.filter(m => m.summaryStatus === 'pending');
    if (pendingMeetings.length === 0) return;

    console.log(`[SidebarProvider] Resuming ${pendingMeetings.length} interrupted summary job(s) from a previous session...`);

    pendingMeetings.forEach(async (meeting) => {
      try {
        const allTranscripts = await fetchAllTranscriptsForMeeting(meeting.id);
        if (!allTranscripts.length) return;

        const [pinnedLanguage, cachedLanguage] = await Promise.all([
          readMeetingSummaryLanguage(meeting.id).catch(() => ({ language: null })),
          readCachedDetectedSummaryLanguage(meeting.id).catch(() => null),
        ]);
        const summaryLanguage = pinnedLanguage.language || cachedLanguage || undefined;

        const { transcriptText } = buildSummaryTranscriptPayload(allTranscripts);
        const result = await invoke<{ process_id: string }>('api_process_transcript', {
          text: transcriptText,
          model: modelConfig.provider,
          modelName: modelConfig.model,
          meetingId: meeting.id,
          chunkSize: 40000,
          overlap: 1000,
          customPrompt: '',
          templateId: undefined,
          summaryLanguage,
        });

        toast.info('Reanudando resumen interrumpido...', {
          description: `"${meeting.title}" quedó pendiente al cerrar la app anteriormente.`,
        });

        startSummaryPolling(meeting.id, result.process_id, async (pollResult) => {
          if (pollResult.status === 'completed') {
            toast.success('Resumen listo', { description: `"${meeting.title}" ya está disponible en el historial.` });
            await fetchMeetings();
          } else if (pollResult.status === 'error' || pollResult.status === 'failed') {
            toast.error('No se pudo generar el resumen', {
              description: `"${meeting.title}": ${pollResult.error || 'error desconocido'}. La transcripción se conservó; puedes reintentarlo desde la reunión.`,
            });
            await fetchMeetings();
          }
        });
      } catch (error) {
        console.error(`[SidebarProvider] Failed to resume pending summary for meeting ${meeting.id}:`, error);
      }
    });
  }, [meetings, isAutoSummary, isModelConfigLoading, modelConfig.provider, modelConfig.model, startSummaryPolling, fetchMeetings]);



  return (
    <SidebarContext.Provider value={{
      currentMeeting,
      setCurrentMeeting,
      sidebarItems,
      isCollapsed,
      toggleCollapse,
      meetings,
      setMeetings,
      isMeetingActive,
      setIsMeetingActive,
      handleRecordingToggle,
      searchTranscripts,
      searchResults,
      isSearching,
      setServerAddress,
      serverAddress,
      transcriptServerAddress,
      setTranscriptServerAddress,
      startSummaryPolling,
      stopSummaryPolling,
      refetchMeetings: fetchMeetings,

    }}>
      {children}
    </SidebarContext.Provider>
  );
}
