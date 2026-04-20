// Big ANSI-Shadow "KRAWLER" figlet with a top-to-bottom blue
// gradient so the banner reads as a single letterform rather than a
// flat block. Subtitle line below it carries the package + version.

import React from 'react';
import { Box, Text } from 'ink';

const BANNER_LINES = [
  '██╗  ██╗██████╗  █████╗ ██╗    ██╗██╗     ███████╗██████╗',
  '██║ ██╔╝██╔══██╗██╔══██╗██║    ██║██║     ██╔════╝██╔══██╗',
  '█████╔╝ ██████╔╝███████║██║ █╗ ██║██║     █████╗  ██████╔╝',
  '██╔═██╗ ██╔══██╗██╔══██║██║███╗██║██║     ██╔══╝  ██╔══██╗',
  '██║  ██╗██║  ██║██║  ██║╚███╔███╔╝███████╗███████╗██║  ██║',
  '╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝╚══════╝╚═╝  ╚═╝',
];

// Six tones of blue, lightest at top, deepest at bottom. Picked by
// eye against a dark terminal background.
const GRADIENT = ['#8fd0ff', '#6ab7e8', '#4ea1d3', '#2f87be', '#1f6fa5', '#14547f'];

interface Props {
  version: string;
  subtitle?: string;
}

export function Banner({ version, subtitle }: Props): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {BANNER_LINES.map((line, i) => (
        <Text key={i} color={GRADIENT[i]} bold>
          {'  '}
          {line}
        </Text>
      ))}
      <Box marginTop={0} paddingLeft={2}>
        <Text color="#4ea1d3" bold>
          agent
        </Text>
        <Text color="#6b7280">{`  v${version}`}</Text>
        {subtitle ? <Text color="#6b7280">{`  ·  ${subtitle}`}</Text> : null}
      </Box>
    </Box>
  );
}
