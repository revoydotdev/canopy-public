/**
 * arbor-eval/stage0/yocto-tasks — the authored feature-injection tasks for
 * yocto-queue.
 *
 * yocto-queue has six public members, too few for body stubs alone, so its
 * stratum is mostly feature requests in the cohort's own style: an injected
 * ava test is the specification, and the reference method below is the
 * reference fix used only to prove the test goes green. References never enter
 * a task fixture.
 *
 * `enqueueAll` is the pinned cohort's own requirement (external-cohort.json,
 * task revision 2), reused verbatim.
 */

export interface YoctoFeatureTask {
  readonly name: string;
  readonly symbol: string;
  readonly edit_paths: readonly string[];
  readonly task_text: string;
  readonly test_path: string;
  readonly test_contents: string;
  /** Inserted before the closing brace of `class Queue` in index.js. */
  readonly reference_js: string;
  /** Inserted before the closing brace of `class Queue` in index.d.ts. */
  readonly reference_dts: string;
}

const suffix = (testPath: string): string =>
  ` The test file ${testPath} specifies the behaviour; make \`npm test\` pass. Do not weaken, skip, or remove any test.`;

const header = "import test from 'ava';\nimport Queue from './index.js';\n\n";

export const YOCTO_FEATURE_TASKS: readonly YoctoFeatureTask[] = [
  {
    name: "enqueue-all",
    symbol: "Queue#enqueueAll",
    edit_paths: ["index.js", "index.d.ts", "readme.md"],
    task_text:
      "Edit exactly index.js, index.d.ts and readme.md; Add a documented Queue#enqueueAll(values) method to index.js, with its TypeScript declaration in index.d.ts and a readme.md entry. It must accept any iterable, preserve FIFO order, keep .size correct, handle queue.enqueueAll(queue) without looping forever, and consume the input completely before mutating the queue so an iterator failure leaves the queue unchanged." +
      suffix("revoy-enqueue-all.test.js"),
    test_path: "revoy-enqueue-all.test.js",
    test_contents: [
      "import test from 'ava';",
      "import Queue from './index.js';",
      "",
      "test('.enqueueAll() appends iterables in FIFO order', t => {",
      "\tconst queue = new Queue();",
      "\tqueue.enqueue('first');",
      "\tqueue.enqueueAll(['second', 'third']);",
      "\tt.deepEqual([...queue], ['first', 'second', 'third']);",
      "\tt.is(queue.size, 3);",
      "",
      "\tconst self = new Queue();",
      "\tself.enqueue('a');",
      "\tself.enqueue('b');",
      "\tself.enqueueAll(self);",
      "\tt.deepEqual([...self], ['a', 'b', 'a', 'b']);",
      "});",
      "",
      "test('.enqueueAll() is atomic when input iteration fails', t => {",
      "\tconst queue = new Queue();",
      "\tqueue.enqueue('stable');",
      "\tconst values = (function * () {",
      "\t\tyield 'must-not-be-appended';",
      "\t\tthrow new Error('input failed');",
      "\t})();",
      "",
      "\tt.throws(() => queue.enqueueAll(values), {message: 'input failed'});",
      "\tt.deepEqual([...queue], ['stable']);",
      "\tt.is(queue.size, 1);",
      "});",
      "",
    ].join("\n"),
    reference_js: "\n\tenqueueAll(values) {\n\t\tfor (const value of [...values]) {\n\t\t\tthis.enqueue(value);\n\t\t}\n\t}\n",
    reference_dts: "\n\t/**\n\tAdd every value of an iterable to the queue.\n\t*/\n\tenqueueAll(values: Iterable<ValueType>): void;\n",
  },
  {
    name: "peek-last",
    symbol: "Queue#peekLast",
    edit_paths: ["index.js", "index.d.ts"],
    task_text:
      "Edit exactly index.js and index.d.ts; Add a documented Queue#peekLast() method to index.js, with its TypeScript declaration in index.d.ts. It returns the most recently enqueued value that is still in the queue without removing it, and undefined when the queue is empty, including after the queue was emptied by dequeue() or clear()." +
      suffix("revoy-peek-last.test.js"),
    test_path: "revoy-peek-last.test.js",
    test_contents: `${header}test('.peekLast()', t => {
\tconst queue = new Queue();
\tt.is(queue.peekLast(), undefined);
\tqueue.enqueue('a');
\tt.is(queue.peekLast(), 'a');
\tqueue.enqueue('b');
\tt.is(queue.peekLast(), 'b');
\tt.is(queue.size, 2);
\tqueue.dequeue();
\tt.is(queue.peekLast(), 'b');
\tqueue.dequeue();
\tt.is(queue.peekLast(), undefined);
\tqueue.enqueue('c');
\tqueue.clear();
\tt.is(queue.peekLast(), undefined);
});
`,
    reference_js: "\n\tpeekLast() {\n\t\treturn this.#tail ? this.#tail.value : undefined;\n\t}\n",
    reference_dts: "\n\t/**\n\tGet the last value in the queue without removing it.\n\t*/\n\tpeekLast(): ValueType | undefined;\n",
  },
  {
    name: "dequeue-many",
    symbol: "Queue#dequeueMany",
    edit_paths: ["index.js", "index.d.ts"],
    task_text:
      "Edit exactly index.js and index.d.ts; Add a documented Queue#dequeueMany(count) method to index.js, with its TypeScript declaration in index.d.ts. It removes up to count values from the front of the queue and returns them as an array in FIFO order, returning fewer when the queue runs out. count must be a non-negative integer; otherwise it throws a RangeError and leaves the queue unchanged." +
      suffix("revoy-dequeue-many.test.js"),
    test_path: "revoy-dequeue-many.test.js",
    test_contents: `${header}test('.dequeueMany()', t => {
\tconst queue = new Queue();
\tfor (const value of [1, 2, 3, 4, 5]) {
\t\tqueue.enqueue(value);
\t}

\tt.deepEqual(queue.dequeueMany(2), [1, 2]);
\tt.is(queue.size, 3);
\tt.deepEqual(queue.dequeueMany(0), []);
\tt.deepEqual(queue.dequeueMany(10), [3, 4, 5]);
\tt.is(queue.size, 0);
\tt.deepEqual(queue.dequeueMany(1), []);
\tqueue.enqueue('x');
\tt.deepEqual([...queue], ['x']);
});

test('.dequeueMany() rejects invalid counts', t => {
\tconst queue = new Queue();
\tqueue.enqueue('a');
\tt.throws(() => queue.dequeueMany(-1), {instanceOf: RangeError});
\tt.throws(() => queue.dequeueMany(1.5), {instanceOf: RangeError});
\tt.is(queue.size, 1);
});
`,
    reference_js:
      "\n\tdequeueMany(count) {\n\t\tif (!Number.isInteger(count) || count < 0) {\n\t\t\tthrow new RangeError('count must be a non-negative integer');\n\t\t}\n\n\t\tconst values = [];\n\t\twhile (values.length < count && this.#size > 0) {\n\t\t\tvalues.push(this.dequeue());\n\t\t}\n\n\t\treturn values;\n\t}\n",
    reference_dts: "\n\t/**\n\tRemove up to `count` values from the front of the queue.\n\t*/\n\tdequeueMany(count: number): ValueType[];\n",
  },
  {
    name: "at",
    symbol: "Queue#at",
    edit_paths: ["index.js", "index.d.ts"],
    task_text:
      "Edit exactly index.js and index.d.ts; Add a documented Queue#at(index) method to index.js, with its TypeScript declaration in index.d.ts. It returns the value at that position without removing anything, with Array.prototype.at semantics: a negative index counts back from the end, and an out-of-range index returns undefined." +
      suffix("revoy-at.test.js"),
    test_path: "revoy-at.test.js",
    test_contents: `${header}test('.at()', t => {
\tconst queue = new Queue();
\tt.is(queue.at(0), undefined);
\tt.is(queue.at(-1), undefined);
\tfor (const value of ['a', 'b', 'c']) {
\t\tqueue.enqueue(value);
\t}

\tt.is(queue.at(0), 'a');
\tt.is(queue.at(2), 'c');
\tt.is(queue.at(3), undefined);
\tt.is(queue.at(-1), 'c');
\tt.is(queue.at(-3), 'a');
\tt.is(queue.at(-4), undefined);
\tt.is(queue.size, 3);
\tqueue.dequeue();
\tt.is(queue.at(0), 'b');
});
`,
    reference_js:
      "\n\tat(index) {\n\t\tconst position = index < 0 ? this.#size + index : index;\n\t\tif (position < 0 || position >= this.#size) {\n\t\t\treturn;\n\t\t}\n\n\t\tlet current = this.#head;\n\t\tfor (let i = 0; i < position; i++) {\n\t\t\tcurrent = current.next;\n\t\t}\n\n\t\treturn current.value;\n\t}\n",
    reference_dts: "\n\t/**\n\tGet the value at a position, counting back from the end for a negative index.\n\t*/\n\tat(index: number): ValueType | undefined;\n",
  },
  {
    name: "remove",
    symbol: "Queue#remove",
    edit_paths: ["index.js", "index.d.ts"],
    task_text:
      "Edit exactly index.js and index.d.ts; Add a documented Queue#remove(value) method to index.js, with its TypeScript declaration in index.d.ts. It removes the first element equal to value under SameValueZero (so NaN matches NaN) and returns true, or returns false when there is none. .size, peek() and later enqueue() calls must stay correct, including when the removed element was the first or the last one." +
      suffix("revoy-remove.test.js"),
    test_path: "revoy-remove.test.js",
    test_contents: `${header}test('.remove()', t => {
\tconst queue = new Queue();
\tt.false(queue.remove('missing'));
\tfor (const value of ['a', 'b', 'a', Number.NaN, 'c']) {
\t\tqueue.enqueue(value);
\t}

\tt.true(queue.remove('a'));
\tt.deepEqual([...queue], ['b', 'a', Number.NaN, 'c']);
\tt.true(queue.remove(Number.NaN));
\tt.true(queue.remove('c'));
\tt.deepEqual([...queue], ['b', 'a']);
\tt.is(queue.size, 2);
\tqueue.enqueue('d');
\tt.deepEqual([...queue], ['b', 'a', 'd']);
\tt.true(queue.remove('b'));
\tt.is(queue.peek(), 'a');
\tt.true(queue.remove('a'));
\tt.true(queue.remove('d'));
\tt.is(queue.size, 0);
\tqueue.enqueue('e');
\tt.deepEqual([...queue], ['e']);
});
`,
    reference_js:
      "\n\tremove(value) {\n\t\tlet previous;\n\t\tlet current = this.#head;\n\t\twhile (current) {\n\t\t\tif (current.value === value || (Number.isNaN(current.value) && Number.isNaN(value))) {\n\t\t\t\tif (previous) {\n\t\t\t\t\tprevious.next = current.next;\n\t\t\t\t} else {\n\t\t\t\t\tthis.#head = current.next;\n\t\t\t\t}\n\n\t\t\t\tif (current === this.#tail) {\n\t\t\t\t\tthis.#tail = previous;\n\t\t\t\t}\n\n\t\t\t\tthis.#size--;\n\t\t\t\treturn true;\n\t\t\t}\n\n\t\t\tprevious = current;\n\t\t\tcurrent = current.next;\n\t\t}\n\n\t\treturn false;\n\t}\n",
    reference_dts: "\n\t/**\n\tRemove the first matching value.\n\t*/\n\tremove(value: ValueType): boolean;\n",
  },
  {
    name: "from",
    symbol: "Queue.from",
    edit_paths: ["index.js", "index.d.ts"],
    task_text:
      "Edit exactly index.js and index.d.ts; Add a documented static Queue.from(iterable) method to index.js, with its TypeScript declaration in index.d.ts. It returns a new Queue holding the iterable's values in iteration order; the new queue must be independent of the source when the source is itself a Queue." +
      suffix("revoy-from.test.js"),
    test_path: "revoy-from.test.js",
    test_contents: `${header}test('Queue.from()', t => {
\tconst queue = Queue.from(['a', 'b', 'c']);
\tt.true(queue instanceof Queue);
\tt.deepEqual([...queue], ['a', 'b', 'c']);
\tt.is(queue.size, 3);
\tt.is(Queue.from([]).size, 0);

\tconst copy = Queue.from(queue);
\tcopy.dequeue();
\tt.is(queue.size, 3);
\tt.deepEqual([...copy], ['b', 'c']);

\tconst generated = Queue.from((function * () {
\t\tyield 1;
\t\tyield 2;
\t})());
\tt.deepEqual([...generated], [1, 2]);
});
`,
    reference_js:
      "\n\tstatic from(iterable) {\n\t\tconst queue = new Queue();\n\t\tfor (const value of iterable) {\n\t\t\tqueue.enqueue(value);\n\t\t}\n\n\t\treturn queue;\n\t}\n",
    reference_dts: "\n\t/**\n\tCreate a queue from an iterable.\n\t*/\n\tstatic from<T>(iterable: Iterable<T>): Queue<T>;\n",
  },
  {
    name: "rotate",
    symbol: "Queue#rotate",
    edit_paths: ["index.js", "index.d.ts"],
    task_text:
      "Edit exactly index.js and index.d.ts; Add a documented Queue#rotate(count = 1) method to index.js, with its TypeScript declaration in index.d.ts. It moves the first count values to the back of the queue, preserving their relative order. count is taken modulo the queue size, rotating an empty queue is a no-op, and a negative or non-integer count throws a RangeError." +
      suffix("revoy-rotate.test.js"),
    test_path: "revoy-rotate.test.js",
    test_contents: `${header}test('.rotate()', t => {
\tconst queue = new Queue();
\tqueue.rotate(3);
\tt.is(queue.size, 0);
\tfor (const value of [1, 2, 3, 4]) {
\t\tqueue.enqueue(value);
\t}

\tqueue.rotate();
\tt.deepEqual([...queue], [2, 3, 4, 1]);
\tqueue.rotate(2);
\tt.deepEqual([...queue], [4, 1, 2, 3]);
\tqueue.rotate(9);
\tt.deepEqual([...queue], [1, 2, 3, 4]);
\tqueue.rotate(0);
\tt.deepEqual([...queue], [1, 2, 3, 4]);
\tqueue.enqueue(5);
\tt.deepEqual([...queue], [1, 2, 3, 4, 5]);
\tt.is(queue.size, 5);
\tt.throws(() => queue.rotate(-1), {instanceOf: RangeError});
});
`,
    reference_js:
      "\n\trotate(count = 1) {\n\t\tif (!Number.isInteger(count) || count < 0) {\n\t\t\tthrow new RangeError('count must be a non-negative integer');\n\t\t}\n\n\t\tif (this.#size === 0) {\n\t\t\treturn;\n\t\t}\n\n\t\tfor (let i = count % this.#size; i > 0; i--) {\n\t\t\tthis.enqueue(this.dequeue());\n\t\t}\n\t}\n",
    reference_dts: "\n\t/**\n\tMove the first `count` values to the back.\n\t*/\n\trotate(count?: number): void;\n",
  },
  {
    name: "retain",
    symbol: "Queue#retain",
    edit_paths: ["index.js", "index.d.ts"],
    task_text:
      "Edit exactly index.js and index.d.ts; Add a documented Queue#retain(predicate) method to index.js, with its TypeScript declaration in index.d.ts. It removes, in place, every value for which predicate(value) returns a falsy result, keeps the rest in order, and returns the number of values removed. .size, peek() and later enqueue() calls must stay correct afterwards." +
      suffix("revoy-retain.test.js"),
    test_path: "revoy-retain.test.js",
    test_contents: `${header}test('.retain()', t => {
\tconst queue = new Queue();
\tt.is(queue.retain(() => false), 0);
\tfor (const value of [1, 2, 3, 4, 5, 6]) {
\t\tqueue.enqueue(value);
\t}

\tt.is(queue.retain(value => value % 2 === 0), 3);
\tt.deepEqual([...queue], [2, 4, 6]);
\tt.is(queue.size, 3);
\tt.is(queue.peek(), 2);
\tqueue.enqueue(8);
\tt.deepEqual([...queue], [2, 4, 6, 8]);
\tt.is(queue.retain(value => value < 5), 2);
\tqueue.enqueue(10);
\tt.deepEqual([...queue], [2, 4, 10]);
\tt.is(queue.retain(() => 0), 3);
\tt.is(queue.size, 0);
\tt.is(queue.peek(), undefined);
\tqueue.enqueue('again');
\tt.deepEqual([...queue], ['again']);
});
`,
    reference_js:
      "\n\tretain(predicate) {\n\t\tconst kept = [];\n\t\tfor (const value of this) {\n\t\t\tif (predicate(value)) {\n\t\t\t\tkept.push(value);\n\t\t\t}\n\t\t}\n\n\t\tconst removed = this.#size - kept.length;\n\t\tthis.clear();\n\t\tfor (const value of kept) {\n\t\t\tthis.enqueue(value);\n\t\t}\n\n\t\treturn removed;\n\t}\n",
    reference_dts: "\n\t/**\n\tKeep only the values matching a predicate.\n\t*/\n\tretain(predicate: (value: ValueType) => unknown): number;\n",
  },
];

/** The existing members whose bodies the body-stub generator may remove (their upstream tests in test.js are the specification). */
export const YOCTO_STUB_MEMBERS: readonly string[] = ["dequeue", "peek", "drain", "[Symbol.iterator]"];
