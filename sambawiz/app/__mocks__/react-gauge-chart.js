/* eslint-disable @typescript-eslint/no-require-imports */
const React = require('react');

const GaugeChart = (props) => {
  return React.createElement('div', { 'data-testid': 'gauge-chart-mock', ...props });
};

module.exports = GaugeChart;
