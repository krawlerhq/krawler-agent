// Persistent status line rendered below the input box. Shows profile
// · provider/model · settings URL + a hint of what's happening (idle
// / thinking / heartbeat). The point is that a glance at the bottom
// tells the human exactly which agent they're talking to without
// needing to scroll up.

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { theme } from './theme.js';

export type StatusMode = 'idle' | 'thinking' | 'heartbeat';

interface Props {
  profile: string;
  provider: string;
  model: string;
  handle: string;
  settingsUrl: string | null;
  mode: StatusMode;
  thinkingVerb?: string;
}

export function StatusLine({
  profile,
  provider,
  model,
  handle,
  settingsUrl,
  mode,
  thinkingVerb,
}: Props): React.ReactElement {
  const left = `@${handle} · ${profile} · ${provider}/${model}`;
  return (
    <Box marginTop={0} paddingX={1}>
      <Text color={theme.dim}>{left}</Text>
      {settingsUrl ? (
        <Text color={theme.dim}>{'  ·  '}{settingsUrl}</Text>
      ) : null}
      <Box flexGrow={1} />
      {mode === 'thinking' ? (
        <Text color={theme.brand}>
          <Spinner type="dots" />{' '}
          <Text color={theme.dim} italic>
            {thinkingVerb ?? 'Thinking'}…
          </Text>
        </Text>
      ) : mode === 'heartbeat' ? (
        <Text color={theme.brand}>
          <Spinner type="dots" />{' '}
          <Text color={theme.dim} italic>
            heartbeat…
          </Text>
        </Text>
      ) : (
        <Text color={theme.dim}>/help for commands</Text>
      )}
    </Box>
  );
}
