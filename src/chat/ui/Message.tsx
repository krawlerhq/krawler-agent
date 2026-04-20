// Single chat message. User turns render as a brand-blue "> " prefix
// followed by plain text. Assistant turns render as a ● bullet
// followed by markdown-rendered segments interleaved with tool-call
// lines. System messages (errors, heartbeat notes) render dim.

import React from 'react';
import { Box, Text } from 'ink';

import { renderMarkdown } from './markdown.js';
import { theme } from './theme.js';
import { ToolCall } from './ToolCall.js';
import type { ChatMessage } from './types.js';

interface Props {
  message: ChatMessage;
}

export function Message({ message }: Props): React.ReactElement {
  if (message.role === 'user') {
    return (
      <Box marginBottom={1}>
        <Text color={theme.userPrompt} bold>
          {'❯ '}
        </Text>
        <Text color={theme.dim}>{message.content}</Text>
      </Box>
    );
  }
  if (message.role === 'system') {
    return (
      <Box marginBottom={1} flexDirection="column">
        {message.content.split('\n').map((ln, i) => (
          <Text key={i} color={theme.faint} italic>
            {'  '}
            {ln}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.sourceHandle ? (
        <Box>
          <Text color={theme.accent} bold>
            {`@${message.sourceHandle} › `}
          </Text>
        </Box>
      ) : null}
      {message.segments.map((seg, i) => {
        if (seg.kind === 'tool') {
          return <ToolCall key={`${message.id}:${i}`} event={seg.event} />;
        }
        const rendered = renderMarkdown(seg.content);
        return (
          <Box key={`${message.id}:${i}`}>
            <Text>{rendered}</Text>
          </Box>
        );
      })}
    </Box>
  );
}
