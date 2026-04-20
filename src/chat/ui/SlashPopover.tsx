// Slash-command autocomplete popover, rendered ABOVE the input box
// while the user's buffer starts with "/". Arrow keys move the
// highlight, Tab/Enter accepts. Matches the Claude-Code suggestion
// feel without us needing a full command palette.

import React from 'react';
import { Box, Text } from 'ink';

import { theme } from './theme.js';

export interface SlashCommand {
  name: string;
  hint: string;
}

interface Props {
  items: SlashCommand[];
  selected: number;
}

export function SlashPopover({ items, selected }: Props): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <Box flexDirection="column" paddingX={1}>
      {items.map((c, i) => {
        const active = i === selected;
        return (
          <Box key={c.name}>
            <Text color={active ? theme.brand : theme.dim}>
              {active ? '▸ ' : '  '}
              {c.name.padEnd(11, ' ')}
            </Text>
            <Text color={theme.dim}>{c.hint}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
