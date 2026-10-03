import metadata from './dialogue-metadata.json';

// JSON is shared with the dashboard without loading the Expo TypeScript project.
// The ID keys retain the original closed sample types and runtime whitelist.
export type DialogueSample = keyof typeof metadata.samples;
type DialogueDetailSample = keyof typeof metadata.details;
export type DialoguePreviewSample = DialogueSample | DialogueDetailSample;

function isDialogueSample(value: string): value is DialogueSample {
  return Object.prototype.hasOwnProperty.call(metadata.samples, value);
}
function isDialogueDetailSample(value: string): value is DialogueDetailSample {
  return Object.prototype.hasOwnProperty.call(metadata.details, value);
}

export const dialogueSamples = Object.keys(metadata.samples).filter(isDialogueSample)
  .map(value => ({ value, ...metadata.samples[value] }));
export const dialogueDetailSamples = Object.keys(metadata.details).filter(isDialogueDetailSample)
  .map(value => ({ value, ...metadata.details[value] }));
const previewSamples = [...dialogueSamples, ...dialogueDetailSamples];
export const dialoguePreviewGroups = metadata.groups.map(group => ({
  id: group.id, title: group.title, items: group.ids.map(id => {
    const sample = previewSamples.find(item => item.value === id);
    if (!sample) throw new Error('등록되지 않은 검수 샘플: ' + id);
    return sample;
  }),
}));

export function getDialoguePreviewSample(search: string): DialoguePreviewSample | null {
  const query = new URLSearchParams(search);
  if (query.get('section') !== 'dialogues') return null;
  return previewSamples.find(sample => sample.value === query.get('sample'))?.value ?? null;
}

export const nativeConfirmations = metadata.nativeConfirmations;
export const nativeRenames = metadata.nativeRenames;
export const nativeMenuTypes = metadata.nativeMenuTypes;
export const alertOwners = metadata.alertOwners;
