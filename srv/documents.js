const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');

const MAX_EXTRACTED_CHARACTERS = 20000;

async function extractDocument(file) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    throw new Error('Choose a non-empty PDF, DOCX, or TXT file to upload.');
  }
  const extension = file.originalname.toLowerCase().split('.').pop();
  let text;

  if (extension === 'pdf') {
    if (file.buffer.indexOf(Buffer.from('%PDF-')) < 0 || file.buffer.indexOf(Buffer.from('%PDF-')) > 1024) {
      throw new Error('This file does not look like a PDF. Choose a valid PDF document.');
    }
    const parsed = await pdfParse(file.buffer);
    text = parsed.text;
  } else if (extension === 'docx') {
    if (file.buffer[0] !== 0x50 || file.buffer[1] !== 0x4b) {
      throw new Error('This file does not look like a DOCX document. Choose a valid DOCX file.');
    }
    const parsed = await mammoth.extractRawText({ buffer: file.buffer });
    text = parsed.value;
  } else if (extension === 'txt') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
    } catch {
      throw new Error('The TXT file must use UTF-8 text encoding.');
    }
  } else {
    throw new Error('Unsupported file type. Upload a PDF, DOCX, or UTF-8 TXT document.');
  }

  text = String(text || '').replace(/\u0000/g, '').trim();
  if (text.length < 10) {
    throw new Error('No readable text was found. Scanned/image-only PDFs need OCR before upload.');
  }
  return {
    text: text.slice(0, MAX_EXTRACTED_CHARACTERS),
    extractedCharacters: text.length,
    truncated: text.length > MAX_EXTRACTED_CHARACTERS
  };
}

module.exports = { extractDocument, MAX_EXTRACTED_CHARACTERS };
