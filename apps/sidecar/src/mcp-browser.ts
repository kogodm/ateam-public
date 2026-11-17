/** The browser Ateam gives a session: one headless Chrome shared by the app,
 *  one tab per session. The stream shows that tab live (see BrowserCard), so
 *  the user sees what the agent is doing instead of a black box. */
import { browserActions as b } from '@ateam/core';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function argOf(flag: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? '') : '';
}

const SESSION_ID = argOf('--session');
const server = new McpServer({ name: 'ateam-browser', version: '1.0.0' });

type Reply = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

async function run(work: () => Promise<string>): Promise<Reply> {
  try {
    return { content: [{ type: 'text', text: await work() }] };
  } catch (e) {
    return {
      content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
      isError: true,
    };
  }
}

server.registerTool(
  'browser_navigate',
  {
    title: 'Open a page',
    description:
      "Open a URL in this session's browser tab (a real Chrome the user can watch in the Ateam stream) and return the page text plus a numbered list of clickable and typeable elements.",
    inputSchema: {
      url: z
        .string()
        .min(1)
        .describe('Address to open; https:// is assumed when no scheme is given.'),
    },
  },
  ({ url }) => run(() => b.navigate(SESSION_ID, url)),
);

server.registerTool(
  'browser_snapshot',
  {
    title: 'Read the page',
    description:
      'Read the current page again: its text and the numbered interactive elements. Take a new one after the page changes.',
    inputSchema: {},
  },
  () => run(() => b.snapshot(SESSION_ID)),
);

server.registerTool(
  'browser_screenshot',
  {
    title: 'Screenshot the page',
    description:
      'A PNG of the visible part of the page, for layout and visual checks the text does not show. Its pixel size is the viewport size times the scale set with browser_viewport. Pass a clip (page pixels) and scale to re-render just a region sharper instead of stretching a small picture.',
    inputSchema: {
      clip: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .optional(),
      scale: z.number().min(0.1).max(4).optional().describe('Used with clip.'),
    },
  },
  async ({ clip, scale }): Promise<Reply> => {
    try {
      return {
        content: [
          {
            type: 'image',
            data: await b.screenshot(SESSION_ID, { clip, scale }),
            mimeType: 'image/png',
          },
        ],
      };
    } catch (e) {
      return {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  'browser_viewport',
  {
    title: 'Set the viewport',
    description:
      'Make the tab a device-sized screen. Use a preset (App Store screenshot sizes: iphone-6.9 = 1320x2868, iphone-6.7 = 1290x2796, iphone-6.5 = 1284x2778, iphone-6.5-old = 1242x2688, iphone-6.1 = 1179x2556, iphone-5.5 = 1242x2208, ipad-13 = 2064x2752, ipad-12.9 = 2048x2732, ipad-11 = 1668x2388, desktop) or give width, height (CSS pixels), scale (device pixel ratio) and mobile; the screenshot is width x scale by height x scale. Stays until changed. Call with reset true to go back to the window size.',
    inputSchema: {
      preset: z
        .enum(Object.keys(b.VIEWPORT_PRESETS) as [b.ViewportPreset, ...b.ViewportPreset[]])
        .optional(),
      landscape: z.boolean().optional().describe('With a preset: swap width and height.'),
      width: z.number().int().min(100).max(4000).optional(),
      height: z.number().int().min(100).max(4000).optional(),
      scale: z.number().min(1).max(4).optional().describe('Device pixel ratio, default 1.'),
      mobile: z.boolean().optional().describe('Emulate a phone (touch, mobile layout).'),
      reset: z.boolean().optional(),
    },
  },
  ({ preset, landscape, width, height, scale, mobile, reset }) =>
    run(() => {
      if (reset) return Promise.resolve(b.resetViewport(SESSION_ID));
      if (preset) {
        const p = b.VIEWPORT_PRESETS[preset];
        return b.viewport(
          SESSION_ID,
          landscape ? { ...p, width: p.height, height: p.width } : { ...p },
        );
      }
      if (!width || !height)
        return Promise.reject(new Error('Give a preset, or width and height, or reset.'));
      return b.viewport(SESSION_ID, { width, height, scale, mobile });
    }),
);

server.registerTool(
  'browser_click',
  {
    title: 'Click an element',
    description:
      'Click element [n] from the latest snapshot, or a point (x, y) in page pixels (use x/y for canvas games or when an element is reported covered). Returns the new page snapshot.',
    inputSchema: {
      index: z.number().int().min(0).optional().describe('Element number from the snapshot.'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
  },
  ({ index, x, y }) =>
    run(() => {
      if (index !== undefined) return b.click(SESSION_ID, index);
      if (x !== undefined && y !== undefined) return b.clickXY(SESSION_ID, x, y);
      return Promise.reject(new Error('Give an element index, or both x and y.'));
    }),
);

server.registerTool(
  'browser_type',
  {
    title: 'Type into an element',
    description:
      'Replace the text of input [n] from the latest snapshot. submit presses Enter afterwards.',
    inputSchema: {
      index: z.number().int().min(0),
      text: z.string(),
      submit: z.boolean().optional(),
    },
  },
  ({ index, text, submit }) => run(() => b.type(SESSION_ID, index, text, submit === true)),
);

server.registerTool(
  'browser_press_key',
  {
    title: 'Press a key',
    description:
      'Press Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, PageUp or PageDown on the focused element.',
    inputSchema: { key: z.string().min(1) },
  },
  ({ key }) => run(() => b.pressKey(SESSION_ID, key)),
);

server.registerTool(
  'browser_scroll',
  {
    title: 'Scroll the page',
    description:
      'Scroll down (positive) or up (negative) by that many pixels and return the snapshot.',
    inputSchema: { pixels: z.number() },
  },
  ({ pixels }) => run(() => b.scroll(SESSION_ID, pixels)),
);

server.registerTool(
  'browser_eval',
  {
    title: 'Run JavaScript in the page',
    description:
      'Evaluate a JavaScript expression in the page and return its value as JSON. Await is supported.',
    inputSchema: { expression: z.string().min(1) },
  },
  ({ expression }) => run(() => b.evalJs(SESSION_ID, expression)),
);

server.connect(new StdioServerTransport()).catch((e) => {
  process.stderr.write(`ateam-browser MCP failed to start: ${String(e)}\n`);
  process.exit(1);
});
