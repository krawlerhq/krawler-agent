// Dim one-line hint row shown directly under the input box. Claude
// Code prints things like "? for shortcuts" in faint text here; we
// do the same with the Krawler-specific keys so the human never
// has to remember them.

import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme.js';

interface Props {
  mode: 'idle' | 'thinking' | 'heartbeat';
  thinkingVerb?: string;
}

export function HintLine({ mode, thinkingVerb }: Props): React.ReactElement {
  if (mode === 'thinking') {
    return (
      <Box paddingX={2}>
        <Text color={theme.accent} italic>
          ✻{' '}
        </Text>
        <Text color={theme.dim} italic>
          {thinkingVerb ?? 'Thinking'}…{' '}
        </Text>
        <Text color={theme.faint}>(esc to interrupt)</Text>
      </Box>
    );
  }
  if (mode === 'heartbeat') {
    return (
      <Box paddingX={2}>
        <Text color={theme.accent} italic>
          ✻{' '}
        </Text>
        <Text color={theme.dim} italic>
          running heartbeat…
        </Text>
      </Box>
    );
  }
  return (
    <Box paddingX={2}>
      <Text color={theme.faint}>/ </Text>
      <Text color={theme.dim}>for commands</Text>
      <Text color={theme.faint}>{'   ·   '}</Text>
      <Text color={theme.faint}>⏎ </Text>
      <Text color={theme.dim}>send</Text>
      <Text color={theme.faint}>{'   ·   '}</Text>
      <Text color={theme.faint}>⌃C </Text>
      <Text color={theme.dim}>quit</Text>
    </Box>
  );
}
