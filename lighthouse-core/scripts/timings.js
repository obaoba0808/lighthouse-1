/**
 * @license Copyright 2019 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

// Example:
//     node lighthouse-core/scripts/timings.js --name my-collection --collect -n 3 --lh-flags='--only-audits=unminified-javascript' --urls https://www.example.com https://www.nyt.com
//     node lighthouse-core/scripts/timings.js --name my-collection --summarize --measure-filter 'loadPage|connect'

const fs = require('fs');
const {execSync} = require('child_process');
const yargs = require('yargs');

const LH_ROOT = `${__dirname}/../..`;
const ROOT_OUTPUT_DIR = `${LH_ROOT}/timings-data`;

const argv = yargs
  .help('help')
  .describe({
    'name': 'Unique identifier, makes the folder for storing LHRs. Not a path',
    // --collect
    'collect': 'Saves LHRs to disk',
    'lh-flags': 'Lighthouse flags',
    'urls': 'Urls to run',
    'n': 'Number of times to run',
    // --summarize
    'summarize': 'Prints statistics report',
    'measure-filter': 'Regex filter of measures to report. Optional',
    'output': 'table, json',
  })
  .string('measure-filter')
  .default('output', 'table')
  .array('urls')
  .string('lh-flags')
  .default('lh-flags', '')
  .wrap(yargs.terminalWidth())
.argv;

const outputDir = `${ROOT_OUTPUT_DIR}/${argv.name}`;

/**
 * @param {number[]} values
 */
function average(values) {
  return values.reduce((sum, value) => sum + value) / values.length;
}

/**
 * Round to the tenth.
 * @param {number} value
 */
function round(value) {
  return Math.round(value * 10) / 10;
}

function collect() {
  if (!fs.existsSync(ROOT_OUTPUT_DIR)) fs.mkdirSync(ROOT_OUTPUT_DIR);
  if (fs.existsSync(outputDir)) throw new Error(`folder already exists: ${outputDir}`);
  fs.mkdirSync(outputDir);

  for (const url of argv.urls) {
    for (let i = 0; i < argv.n; i++) {
      const cmd = [
        'node',
        `${LH_ROOT}/lighthouse-cli`,
        url,
        `--output-path=${outputDir}/lhr-${url.replace(/[^a-zA-Z0-9]/g, '_')}-${i}.json`,
        '--output=json',
        argv.lhFlags,
      ].join(' ');
      execSync(cmd, {stdio: 'ignore'});
    }
  }
}

function summarize() {
  /** @type {Map<string, number[]>} */
  const measuresMap = new Map();
  /** @type {RegExp|null} */
  const measureFilter = argv.measureFilter ? new RegExp(argv.measureFilter, 'i') : null;

  for (const lhrPath of fs.readdirSync(outputDir)) {
    const lhrJson = fs.readFileSync(`${outputDir}/${lhrPath}`, 'utf-8');
    /** @type {LH.Result} */
    const lhr = JSON.parse(lhrJson);

    for (const measureName of lhr.timing.entries.map(entry => entry.name)) {
      if (measureFilter && !measureFilter.test(measureName)) {
        continue;
      }

      const measuresKey = `${lhr.requestedUrl}@@@${measureName}`;
      let measures = measuresMap.get(measuresKey);
      if (!measures) {
        measures = [];
        measuresMap.set(measuresKey, measures);
      }

      const measureEntry = lhr.timing.entries.find(measure => measure.name === measureName);
      if (!measureEntry) throw new Error('missing measure');

      measures.push(measureEntry.duration);
    }
  }

  const results = [...measuresMap.entries()].map(([measuresKey, measures]) => {
    const [url, measureName] = measuresKey.split('@@@');
    const mean = average(measures);
    const min = Math.min(...measures);
    const max = Math.max(...measures);
    const stdev = Math.sqrt(average(measures.map(measure => (measure - mean) ** 2)));
    return {
      measure: measureName,
      url,
      n: measures.length,
      mean: round(mean),
      stdev: round(stdev),
      min: round(min),
      max: round(max),
    };
  }).sort((a, b) => {
    // sort by {measure, url}
    const measureComp = a.measure.localeCompare(b.measure);
    if (measureComp !== 0) return measureComp;
    return a.url.localeCompare(b.url);
  });

  if (argv.output === 'table') {
    // eslint-disable-next-line no-console
    console.table(results);
  } else if (argv.output === 'json') {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(results, null, 2));
  }
}

function main() {
  if (argv.collect) collect();
  if (argv.summarize) summarize();
}

main();
