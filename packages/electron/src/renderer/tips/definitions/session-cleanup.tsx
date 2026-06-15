/**
 * Tip: Session Cleanup
 *
 * Surfaces the /session-cleanup workflow to users running many sessions --
 * once the Sessions board accumulates cards, the agent can re-phase finished
 * work, mark it complete, and flag old sessions to archive.
 */

import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime';
import { FEATURE_USAGE_KEYS } from '../../../shared/featureUsage';
import type { TipDefinition } from '../types';

const CleanupIcon = <MaterialSymbol icon="cleaning_services" size={16} />;

export const sessionCleanupTip: TipDefinition = {
  id: 'tip-session-cleanup',
  name: 'Session Cleanup',
  version: 1,
  trigger: {
    screen: 'agent',
    condition: (context) =>
      context.hasReachedCount(FEATURE_USAGE_KEYS.SESSION_CREATED, 20),
    delay: 2000,
    priority: 4,
  },
  content: {
    icon: CleanupIcon,
    title: 'Let your agent tidy the Sessions board',
    body: 'Your Sessions board is filling up. Ask your agent to **clean it up** -- it can fix each session\'s phase, mark finished work **complete**, and flag old sessions to archive. With Claude Code, just run **/session-cleanup**.',
  },
};
