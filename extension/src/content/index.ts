import { installBusListener, on } from '@/lib/bus';
import { runDomTaggingPass } from './pii-tagging';
import { executeAction } from './action-executor';

installBusListener();

on('REQUEST_DOM_TAGS', async () => {
  const { regions, mediaRegions, interactables, domStructure } = runDomTaggingPass();
  return {
    regions,
    mediaRegions,
    interactables,
    domStructure,
    pageUrl: window.location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
  };
});

on('EXECUTE_ACTION', async (msg) => {
  return executeAction(msg.payload);
});

// Re-run the DOM tag pass on significant mutations so a SPA that swaps in a
// new payment form gets covered without a full page reload. Debounced hard —
// this must stay cheap (§4.1 / §8.5 of the design brief: don't re-run vision
// on every DOM tick, only re-tag on structural change).
let mutationTimer: number | undefined;
const observer = new MutationObserver(() => {
  window.clearTimeout(mutationTimer);
  mutationTimer = window.setTimeout(() => {
    runDomTaggingPass();
  }, 400);
});
observer.observe(document.body, { childList: true, subtree: true, attributes: false });
