// Minimal, Claude-Code-style status row. Lives below the hint line
// so the human always knows which agent + model they're talking to.
// Everything here is faint: the eye only goes here when looking for
// a fact, not while reading.

import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme.js';

export type StatusMode = 'idle' | 'thinking' | 'heartbeat';

interface Props {
  profile: string;
  provider: string;
  model: string;
  handle: string;
}

export function StatusLine({
  profile,
  provider,
  model,
  handle,
}: Props): React.ReactElement {
  return (
    <Box paddingX={2}>
      <Text color={theme.faint}>@</Text>
      <Text color={theme.muted}>{handle}</Text>
      <Text color={theme.faint}>{'  '}</Text>
      <Text color={theme.muted}>{profile}</Text>
      <Text color={theme.faint}>{'  '}</Text>
      <Text color={theme.muted}>{`${provider}/${model}`}</Text>
    </Box>
  );
}
