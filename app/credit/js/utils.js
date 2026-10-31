const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', maximumFractionDigits: 0
});

export const formatINR = value => Number.isFinite(Number(value)) ? inr.format(Number(value)) : 'No limit';
export const formatPercent = value => value !== null && value !== undefined && Number.isFinite(Number(value))
  ? `${(Number(value) * 100).toFixed(1)}%` : 'No limit';
export const formatDate = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(date);
};
export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}
export const statusClass = status => String(status || '').toLowerCase().replace(/[^a-z_]/g, '');
