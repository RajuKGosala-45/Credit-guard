import { escapeHTML } from '../utils.js';

export function renderChat(messages) {
  const host = document.querySelector('#chat-messages');
  if (!messages.length) {
    host.innerHTML = '<p class="empty-state">Ask about exposure, flagged customers, or a customer ID such as C001. Without an API key, the assistant uses the same live data tools in offline demo mode.</p>';
    return;
  }
  host.innerHTML = messages.map(message =>
    `<div class="chat-message ${message.role === 'user' ? 'user' : 'assistant'}">${escapeHTML(message.text)}</div>`
  ).join('');
  host.scrollTop = host.scrollHeight;
}

export async function handleChatSubmit(event, send, messages, documentContext) {
  event.preventDefault();
  const input = document.querySelector('#chat-input');
  const errorHost = document.querySelector('#chat-error');
  const message = input.value.trim();
  if (!message) return null;
  input.value = '';
  errorHost.textContent = '';
  messages.push({ role: 'user', text: message });
  renderChat(messages);
  try {
    const result = await send(message, documentContext);
    messages.push({ role: 'assistant', text: result.reply });
    renderChat(messages);
    return result;
  } catch (error) {
    errorHost.textContent = error.message;
    return null;
  }
}

export async function explainCustomer(customer, send, messages, documentContext) {
  const question = `Explain and recommend whether to increase the limit for ${customer.name} (${customer.ID}).`;
  messages.push({ role: 'user', text: question });
  renderChat(messages);
  try {
    const result = await send(question, documentContext);
    messages.push({ role: 'assistant', text: result.reply });
    renderChat(messages);
  } catch (error) {
    document.querySelector('#chat-error').textContent = error.message;
  }
}
