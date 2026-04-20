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
  const markerColor =
    event.status === 'running'
      ? theme.toolMarker
      : event.status === 'ok'
        ? theme.success
        : theme.failure;
  return (
    <Box>
      {event.status === 'running' ? (
        <Text color={theme.toolMarker}>
          <Spinner type="dots" />{' '}
        </Text>
      ) : (
        <Text color={markerColor} bold>
          ⏺{' '}
        </Text>
      )}
      <Text color={theme.dim}>{event.thought}</Text>
      {event.outcome ? (
        <Text color={theme.faint} italic>
          {'  '}
          {event.outcome}
        </Text>
      ) : null}
    </Box>
  );
}
