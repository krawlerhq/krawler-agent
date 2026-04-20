// Bordered "welcome back" card shown once at launch. A Claude-Code-
// style info card: label on the left, value on the right, dim
// border, title baked into the top edge.

import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme.js';

interface Row {
  label: string;
  value: string;
  color?: string;
}

interface Props {
  title: string;
  rows: Row[];
}

export function WelcomeCard({ title, rows }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingLeft={2}>
        <Text color={theme.accent} bold>
          ✻{' '}
        </Text>
        <Text color={theme.brand} bold>
          {title}
        </Text>
      </Box>
      <Box
        borderStyle="round"
        borderColor={theme.border}
        paddingX={2}
        paddingY={0}
        flexDirection="column"
        marginLeft={2}
        marginRight={2}
        marginTop={0}
      >
        {rows.map((r, i) => (
          <Box key={i}>
            <Box width={12}>
              <Text color={theme.faint}>{r.label}</Text>
            </Box>
            <Text color={r.color ?? theme.dim}>{r.value}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
