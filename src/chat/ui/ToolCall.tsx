// One tool-call line inside an assistant turn. Renders the "thought"
// (what the model said it was about to do) in dim italic, followed by
// a ✓ / ✗ + outcome once execute() resolves. While running, a small
// spinner stands in for the marker.

import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

import { theme } from './theme.js';
import type { ToolEvent } from './types.js';

interface Props {
  event: ToolEvent;
}

export function ToolCall({ event }: Props): React.ReactElement {
  return (
    <Box>
      <Text color={theme.toolText}>{'  '}</Text>
      {event.status === 'running' ? (
        <Text color={theme.brand}>
          <Spinner type="dots" />{' '}
        </Text>
      ) : (
        <Text color={event.status === 'ok' ? theme.success : theme.failure}>
          {event.status === 'ok' ? '✓' : '✗'}{' '}
        </Text>
      )}
      <Text color={theme.toolText} italic>
        {event.thought}
      </Text>
      {event.outcome ? (
        <Text color={theme.toolText} italic>
          {'  '}
          {event.outcome}
        </Text>
      ) : null}
    </Box>
  );
}
