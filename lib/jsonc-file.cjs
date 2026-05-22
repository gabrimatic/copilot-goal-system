"use strict";

const {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} = require("jsonc-parser");

const formattingOptions = {
  eol: "\n",
  insertSpaces: true,
  tabSize: 2,
};

function formatParseErrors(errors) {
  return errors
    .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
    .join(", ");
}

function parseJsoncText(raw, filePath) {
  if (!raw.trim()) return {};
  const errors = [];
  const value = parse(raw, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const details = formatParseErrors(errors);
    throw new SyntaxError(`${filePath} is not valid JSON/JSONC (${details}). Fix it before installing; that config file was not changed.`);
  }
  return value === undefined ? {} : value;
}

function updateJsoncPath(raw, path, value) {
  const source = raw && raw.trim() ? raw : "{}\n";
  const edits = modify(source, path, value, {
    formattingOptions,
    getInsertionIndex: (properties) => properties.length,
  });
  return applyEdits(source, edits);
}

module.exports = {
  parseJsoncText,
  updateJsoncPath,
};
