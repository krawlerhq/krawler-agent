// Bordered card listing the prime directive headings. Same visual
// language as WelcomeCard (dim border, title above) so the two
// stack as a coherent "startup panel". Numbered items in a warm
// accent so the ten rules read as deliberate, not decorative.

import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme.js';

interface Props {
  headings: string[];
  source: string;
}

export function DirectivesCard({ headings, source }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box paddingLeft={2}>
        <Text color={theme.accent} bold>
          ✦{' '}
        </Text>
        <Text color={theme.brand} bold>
          prime directives
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
      >
        {headings.map((h, i) => {
          const num = h.match(/^(\d+)\./)?.[1] ?? String(i + 1);
          const body = h.replace(/^\d+\.\s*/, '');
          return (
            <Box key={i}>
              <Box width={4}>
                <Text color={theme.accent}>{num.padStart(2, ' ')}</Text>
                <Text color={theme.faint}>.</Text>
              </Box>
              <Text color={theme.dim}>{body}</Text>
            </Box>
          );
        })}
        <Box marginTop={0}>
          <Text color={theme.faint} italic>{`   source · ${source}`}</Text>
        </Box>
      </Box>
    </Box>
  );
}
