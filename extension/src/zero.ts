import { brandMark } from './icons.js';

const mark = document.getElementById('mark');
if (mark) mark.innerHTML = brandMark(52);

const params = new URLSearchParams(location.search);
const closedCount = Number(params.get('closed') || 0);
const trailCount = Number(params.get('trails') || 0);
const sub = document.getElementById('sub');
if (sub) {
  const trailTxt = `<b>${trailCount}</b> research trail${trailCount === 1 ? '' : 's'}`;
  sub.innerHTML =
    closedCount > 0
      ? `<b>${closedCount}</b> tab${closedCount === 1 ? '' : 's'} closed. Saved as ${trailTxt}. Nothing lost.`
      : `Saved as ${trailTxt}. Nothing lost.`;
}
