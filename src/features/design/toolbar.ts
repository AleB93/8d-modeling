import type { Tool } from './DesignCanvas';

/** Design toolbar buttons, in order, with their keyboard shortcut. */
export const TOOLS: { t: Tool; key: string; label: string }[] = [
  { t: 'select', key: 'V', label: 'Select' },
  { t: 'hand', key: 'H', label: 'Pan' },
  { t: 'arrow', key: 'A', label: 'Connect' },
  { t: 'service', key: 'S', label: 'Service' },
  { t: 'database', key: 'D', label: 'Database' },
  { t: 'queue', key: 'Q', label: 'Queue' },
  { t: 'cache', key: 'K', label: 'Cache' },
  { t: 'lb', key: 'L', label: 'Load balancer' },
  { t: 'client', key: 'C', label: 'Client' },
  { t: 'zone', key: 'Z', label: 'Zone' },
  { t: 'text', key: 'T', label: 'Text' },
];
