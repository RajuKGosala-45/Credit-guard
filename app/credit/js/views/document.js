import { renderChat } from './chat.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const allowedExtensions = ['pdf', 'docx', 'txt'];

export async function handleDocumentSubmit(event, analyze, messages, onAnalyzed) {
  event.preventDefault();
  const input = document.querySelector('#document-file');
  const status = document.querySelector('#document-status');
  const submit = event.currentTarget.querySelector('[type="submit"]');
  const file = input.files[0];
  status.classList.remove('error');
  if (!file) {
    status.classList.add('error');
    status.textContent = 'Choose a PDF, DOCX, or TXT file first.';
    return;
  }
  const extension = file.name.split('.').pop().toLowerCase();
  if (!allowedExtensions.includes(extension) || file.size > MAX_FILE_BYTES) {
    status.classList.add('error');
    status.textContent = file.size > MAX_FILE_BYTES
      ? 'This file is larger than 10 MB. Choose a smaller document.'
      : 'Unsupported file type. Choose a PDF, DOCX, or TXT document.';
    return;
  }
  submit.disabled = true;
  status.textContent = `Reading ${file.name}…`;
  try {
    const result = await analyze(file);
    onAnalyzed({
      filename: result.filename,
      text: result.extractedText || result.text,
      extractedCharacters: result.extractedCharacters,
      truncated: result.truncated
    });
    messages.push({
      role: 'assistant',
      text: result.reply,
      provider: result.provider,
      modulesUsed: result.modulesUsed,
      dataSourcesUsed: result.dataSourcesUsed,
      providerFallbackReason: result.providerFallback ? result.providerFallbackReason : null
    });
    renderChat(messages);
    status.textContent = `${result.filename} read (${result.extractedCharacters.toLocaleString('en-IN')} characters). Follow-up questions use this document until it is removed.${result.truncated ? ' Only the first 20,000 characters were analyzed.' : ''}`;
    document.querySelector('#clear-document').disabled = false;
  } catch (error) {
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
}

export function clearDocument(onClear) {
  onClear();
  document.querySelector('#document-form').reset();
  document.querySelector('#document-status').textContent = 'Document context removed. New questions will use portfolio data only.';
  document.querySelector('#clear-document').disabled = true;
}
