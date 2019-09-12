/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* eslint-env jest */

const MainThreadTasks = require('../../../lib/tracehouse/main-thread-tasks.js');
const TraceProcessor = require('../../../lib/tracehouse/trace-processor.js');
const taskGroups = require('../../../lib/tracehouse/task-groups.js').taskGroups;
const pwaTrace = require('../../fixtures/traces/progressive-app.json');
const TracingProcessor = require('../../../lib/tracehouse/trace-processor.js');
const assert = require('assert');

describe('Main Thread Tasks', () => {
  const pid = 1;
  const tid = 2;
  const frameId = 'BLAH';
  const args = {data: {}, frame: frameId};
  const baseTs = 1241250325;
  let boilerplateTrace;

  beforeEach(() => {
    boilerplateTrace = [
      {ph: 'I', name: 'TracingStartedInPage', pid, tid, ts: baseTs, args: {data: {page: frameId}}},
      {ph: 'I', name: 'navigationStart', pid, tid, ts: baseTs, args},
      {ph: 'R', name: 'firstContentfulPaint', pid, tid, ts: baseTs + 1, args},
    ];
  });

  function run(trace) {
    const {mainThreadEvents, timestamps} = TraceProcessor.computeTraceOfTab(trace);
    return MainThreadTasks.getMainThreadTasks(mainThreadEvents, timestamps.traceEnd);
  }

  it('should get all main thread tasks from a trace', () => {
    const tasks = run({traceEvents: pwaTrace});
    const toplevelTasks = tasks.filter(task => !task.parent);
    assert.equal(tasks.length, 2305);
    assert.equal(toplevelTasks.length, 296);

    // Sanity check the reachability of tasks and summation of selfTime
    const allTasks = [];
    const queue = toplevelTasks;
    let totalTime = 0;
    let totalTopLevelTime = 0;
    while (queue.length) {
      const task = queue.shift();
      totalTime += task.selfTime;
      totalTopLevelTime += TracingProcessor.isScheduleableTask(task.event) ? task.duration : 0;
      allTasks.push(task);
      queue.push(...task.children);
    }

    assert.equal(allTasks.length, 2305);
    assert.equal(Math.round(totalTopLevelTime), 386);
    assert.equal(Math.round(totalTime), 396);
  });

  it('should compute parent/child correctly', () => {
    /*
    An artistic rendering of the below trace:
    █████████████████████████████TaskA██████████████████████████████████████████████
          ████████████████TaskB███████████████████
               ████TaskC██████
    */
    const traceEvents = [
      ...boilerplateTrace,
      {ph: 'X', name: 'TaskA', pid, tid, ts: baseTs, dur: 100e3, args},
      {ph: 'B', name: 'TaskB', pid, tid, ts: baseTs + 5e3, args},
      {ph: 'X', name: 'TaskC', pid, tid, ts: baseTs + 10e3, dur: 30e3, args},
      {ph: 'E', name: 'TaskB', pid, tid, ts: baseTs + 55e3, args},
    ];

    traceEvents.forEach(evt => Object.assign(evt, {cat: 'devtools.timeline'}));

    const tasks = run({traceEvents});
    assert.equal(tasks.length, 3);

    const taskA = tasks.find(task => task.event.name === 'TaskA');
    const taskB = tasks.find(task => task.event.name === 'TaskB');
    const taskC = tasks.find(task => task.event.name === 'TaskC');
    assert.deepStrictEqual(taskA, {
      parent: undefined,
      attributableURLs: [],

      children: [taskB],
      event: traceEvents[3],
      startTime: 0,
      endTime: 100,
      duration: 100,
      selfTime: 50,
      group: taskGroups.other,
    });

    assert.deepStrictEqual(taskB, {
      parent: taskA,
      attributableURLs: [],

      children: [taskC],
      event: traceEvents[4],
      startTime: 5,
      endTime: 55,
      duration: 50,
      selfTime: 20,
      group: taskGroups.other,
    });
  });

  it('should compute attributableURLs correctly', () => {
    const baseTs = 1241250325;
    const url = s => ({args: {data: {url: s}}});
    const stackFrames = f => ({args: {data: {stackTrace: f.map(url => ({url}))}}});

    /*
    An artistic rendering of the below trace:
    █████████████████████████████TaskA██████████████████████████████████████████████
          ████████████████TaskB███████████████████
               ████EvaluateScript██████
                   █D█
    */
    const traceEvents = [
      ...boilerplateTrace,
      {ph: 'X', name: 'TaskA', pid, tid, ts: baseTs, dur: 100e3, ...url('about:blank')},
      {ph: 'B', name: 'TaskB', pid, tid, ts: baseTs + 5e3, ...stackFrames(['urlB.1', 'urlB.2'])},
      {ph: 'X', name: 'EvaluateScript', pid, tid, ts: baseTs + 10e3, dur: 30e3, ...url('urlC')},
      {ph: 'X', name: 'TaskD', pid, tid, ts: baseTs + 15e3, dur: 5e3, ...stackFrames(['urlD'])},
      {ph: 'E', name: 'TaskB', pid, tid, ts: baseTs + 55e3},
    ];

    traceEvents.forEach(evt => {
      evt.cat = 'devtools.timeline';
      evt.args = evt.args || args;
    });

    const tasks = run({traceEvents});
    const taskA = tasks.find(task => task.event.name === 'TaskA');
    const taskB = tasks.find(task => task.event.name === 'TaskB');
    const taskC = tasks.find(task => task.event.name === 'EvaluateScript');
    const taskD = tasks.find(task => task.event.name === 'TaskD');

    assert.deepStrictEqual(taskA.attributableURLs, []);
    assert.deepStrictEqual(taskB.attributableURLs, ['urlB.1', 'urlB.2']);
    assert.deepStrictEqual(taskC.attributableURLs, ['urlB.1', 'urlB.2', 'urlC']);
    assert.deepStrictEqual(taskD.attributableURLs, ['urlB.1', 'urlB.2', 'urlC', 'urlD']);
  });

  it('should handle the last trace event not ending', () => {
    /*
    An artistic rendering of the below trace:
    █████████████████████████████TaskA████████████|
          ████████████████TaskB███████████████████|
                                            █TaskC|
                                                  ^ trace abruptly ended
    */
    const traceEvents = [
      ...boilerplateTrace,
      // These events would normally be accompanied by an 'E' event
      {ph: 'B', name: 'TaskA', pid, tid, ts: baseTs, args},
      {ph: 'B', name: 'TaskB', pid, tid, ts: baseTs + 5e3, args},
      {ph: 'B', name: 'TaskC', pid, tid, ts: baseTs + 100e3, args},
    ];

    traceEvents.forEach(evt => Object.assign(evt, {cat: 'devtools.timeline'}));

    const tasks = run({traceEvents});
    expect(tasks).toHaveLength(3);

    const taskA = tasks.find(task => task.event.name === 'TaskA');
    const taskB = tasks.find(task => task.event.name === 'TaskB');
    const taskC = tasks.find(task => task.event.name === 'TaskC');
    expect(taskA).toEqual({
      parent: undefined,
      attributableURLs: [],

      children: [taskB],
      event: traceEvents[3],
      startTime: 0,
      endTime: 100,
      duration: 100,
      selfTime: 5,
      group: taskGroups.other,
    });

    expect(taskB).toEqual({
      parent: taskA,
      attributableURLs: [],

      children: [taskC],
      event: traceEvents[4],
      startTime: 5,
      endTime: 100,
      duration: 95,
      selfTime: 95,
      group: taskGroups.other,
    });
  });

  it('should handle nested events *starting* at the same timestamp correctly', () => {
    const traceEvents = [
      ...boilerplateTrace,
      {ph: 'B', name: 'TaskB', pid, tid, ts: baseTs, args},
      {ph: 'B', name: 'TaskC', pid, tid, ts: baseTs, args},
      {ph: 'X', name: 'TaskA', pid, tid, ts: baseTs, dur: 100e3, args},
      {ph: 'E', name: 'TaskB', pid, tid, ts: baseTs + 50e3, args},
      {ph: 'E', name: 'TaskC', pid, tid, ts: baseTs + 25e3, args},
      {ph: 'X', name: 'TaskD', pid, tid, ts: baseTs + 100e3, dur: 100e3, args},
    ];

    traceEvents.forEach(evt => Object.assign(evt, {cat: 'devtools.timeline'}));

    const tasks = run({traceEvents});
    expect(tasks).toMatchObject([
      {event: {name: 'TaskA'}, parent: undefined, startTime: 0, endTime: 100},
      {event: {name: 'TaskB'}, parent: {event: {name: 'TaskA'}}, startTime: 0, endTime: 50},
      {event: {name: 'TaskC'}, parent: {event: {name: 'TaskB'}}, startTime: 0, endTime: 25},
      {event: {name: 'TaskD'}, parent: undefined, startTime: 100, endTime: 200},
    ]);
  });

  it('should handle nested events *ending* at the same timestamp correctly', () => {
    const traceEvents = [
      ...boilerplateTrace,
      {ph: 'B', name: 'TaskA', pid, tid, ts: baseTs, args},
      {ph: 'X', name: 'TaskB', pid, tid, ts: baseTs + 50e3, dur: 50e3, args},
      {ph: 'B', name: 'TaskC', pid, tid, ts: baseTs + 75e3, args},
      {ph: 'X', name: 'TaskD', pid, tid, ts: baseTs + 100e3, dur: 100e3, args},
      {ph: 'E', name: 'TaskA', pid, tid, ts: baseTs + 100e3, args},
      {ph: 'E', name: 'TaskC', pid, tid, ts: baseTs + 100e3, args},
    ];

    traceEvents.forEach(evt => Object.assign(evt, {cat: 'devtools.timeline'}));

    const tasks = run({traceEvents});
    expect(tasks).toMatchObject([
      {event: {name: 'TaskA'}, parent: undefined, startTime: 0, endTime: 100},
      {event: {name: 'TaskB'}, parent: {event: {name: 'TaskA'}}, startTime: 50, endTime: 100},
      {event: {name: 'TaskC'}, parent: {event: {name: 'TaskB'}}, startTime: 75, endTime: 100},
      {event: {name: 'TaskD'}, parent: undefined, startTime: 100, endTime: 200},
    ]);
  });

  it('should handle nested events of the same name', () => {
    /*
    An artistic rendering of the below trace:
    █████████████████████████████TaskANested██████████████████████████████████████████████
    ████████████████TaskB███████████████████
               ████TaskANested██████
    */
    const traceEvents = [
      ...boilerplateTrace,
      {ph: 'B', name: 'TaskANested', pid, tid, ts: baseTs, args},
      {ph: 'X', name: 'TaskB', pid, tid, ts: baseTs, dur: 50e3, args},
      {ph: 'B', name: 'TaskANested', pid, tid, ts: baseTs + 25e3, args},
      {ph: 'E', name: 'TaskANested', pid, tid, ts: baseTs + 45e3, args},
      {ph: 'E', name: 'TaskANested', pid, tid, ts: baseTs + 100e3, args},
    ];

    traceEvents.forEach(evt => Object.assign(evt, {cat: 'devtools.timeline'}));

    const tasks = run({traceEvents});
    expect(tasks).toMatchObject([
      {event: {name: 'TaskANested'}, parent: undefined, startTime: 0, endTime: 100},
      {event: {name: 'TaskB'}, parent: {event: {name: 'TaskANested'}}, startTime: 0, endTime: 50},
      {event: {name: 'TaskANested'}, parent: {event: {name: 'TaskB'}}, startTime: 25, endTime: 45},
    ]);
  });

  const invalidEventSets = [
    [
      // TaskA overlaps with TaskB, X first
      {ph: 'X', name: 'TaskA', pid, tid, ts: baseTs, dur: 100e3, args},
      {ph: 'B', name: 'TaskB', pid, tid, ts: baseTs + 5e3, args},
      {ph: 'E', name: 'TaskB', pid, tid, ts: baseTs + 115e3, args},
    ],
    [
      // TaskA overlaps with TaskB, B first
      {ph: 'B', name: 'TaskA', pid, tid, ts: baseTs, args},
      {ph: 'X', name: 'TaskB', pid, tid, ts: baseTs + 5e3, dur: 100e3, args},
      {ph: 'E', name: 'TaskA', pid, tid, ts: baseTs + 90e3, args},
    ],
    [
      // TaskA is missing a B event
      {ph: 'E', name: 'TaskA', pid, tid, ts: baseTs, args},
      {ph: 'B', name: 'TaskB', pid, tid, ts: baseTs + 5e3, args},
      {ph: 'E', name: 'TaskB', pid, tid, ts: baseTs + 115e3, args},
    ],
    [
      // TaskB is missing a B event after an X
      {ph: 'X', name: 'TaskA', pid, tid, ts: baseTs, dur: 100e3, args},
      {ph: 'E', name: 'TaskB', pid, tid, ts: baseTs + 10e3, args},
    ],
  ];

  for (const invalidEvents of invalidEventSets) {
    it('should throw on invalid task input', () => {
      const traceEvents = [
        ...boilerplateTrace,
        ...invalidEvents,
      ];

      traceEvents.forEach(evt => Object.assign(evt, {cat: 'devtools.timeline'}));

      expect(() => run({traceEvents})).toThrow();
    });
  }
});
