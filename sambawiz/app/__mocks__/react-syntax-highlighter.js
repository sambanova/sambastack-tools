const React = require('react');

const Prism = ({ children }) => {
  return React.createElement('pre', null, children);
};

// Mock style object
const mockStyle = {};

module.exports = {
  Prism,
  default: Prism,
  // Export mock styles
  vscDarkPlus: mockStyle,
  atomDark: mockStyle,
  prism: mockStyle,
};
