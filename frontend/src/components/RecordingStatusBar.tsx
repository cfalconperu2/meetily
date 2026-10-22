'use client';

import { motion } from 'framer-motion';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useEffect, useState } from 'react';
import { recordingService } from '@/services/recordingService';
import { CompactAudioLevelMeter } from '@/components/AudioLevelMeter';
import type { AudioLevelData } from '@/components/DeviceSelection';

interface RecordingStatusBarProps {
  isPaused?: boolean;
}

export const RecordingStatusBar: React.FC<RecordingStatusBarProps> = ({ isPaused = false }) => {
  // Get recording duration from backend-synced context (in seconds)
  // Backend polls every 500ms, providing smooth updates
  const { activeDuration, isRecording } = useRecordingState();

  // Display state synced from backend
  const [displaySeconds, setDisplaySeconds] = useState(0);

  // Live mic/system levels for the OBS-style meter. This component only
  // mounts while actively recording, so no extra isRecording gating is
  // needed here -- mount/unmount is the gate.
  const [levels, setLevels] = useState<Map<string, AudioLevelData>>(new Map());

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    recordingService.onRecordingAudioLevels(({ levels: incoming }) => {
      const next = new Map<string, AudioLevelData>();
      incoming.forEach((l) => next.set(l.device_name, l));
      setLevels(next);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Sync with backend duration when it changes (handles refresh/navigation)
  useEffect(() => {
    if (activeDuration !== null) {
      // Round to nearest second to avoid decimal issues
      setDisplaySeconds(Math.floor(activeDuration));
    }
  }, [activeDuration]);

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -10 }}
      transition={{ duration: 0.2 }}
      className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg mb-2"
    >
      <div className={`w-2 h-2 rounded-full ${isPaused ? 'bg-orange-500' : 'bg-red-500 animate-pulse'}`} />
      <span className={`text-sm ${isPaused ? 'text-orange-700' : 'text-gray-700'}`}>
        {isPaused ? 'Paused' : 'Recording'} • {formatDuration(displaySeconds)}
      </span>
      {Array.from(levels.values()).map((level) => (
        <CompactAudioLevelMeter
          key={level.device_name}
          rmsLevel={level.rms_level}
          peakLevel={level.peak_level}
          isActive={level.is_active}
        />
      ))}
    </motion.div>
  );
};
