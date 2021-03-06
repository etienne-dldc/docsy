import { DocsyUnexpectedError } from '../DocsyError.js';
import { StringReader } from './StringReader.js';
import { Stack, StackItem, StackOrNull } from './types.js';

export type Job<T, Ctx> = {
  parser: ParserJob<T, Ctx>;
  ref: {};
};

export type JobResult = {
  ref: {};
  value: ParseResult<unknown>;
};

type Unwrap<T> = (result: JobResult) => ParseResult<T>;

export function createJob<T, Ctx>(parser: ParserJob<T, Ctx>): [Job<T, Ctx>, Unwrap<T>] {
  const ref = {};

  return [
    { ref, parser },
    (result) => {
      if (result.ref !== ref) {
        throw new Error(`Invalid job result`);
      }
      return result.value as any;
    },
  ];
}

interface ParseResultFailure {
  type: 'Failure';
  stack: StackItem;
}

export interface ParseResultSuccess<T> {
  type: 'Success';
  value: T;
  start: number;
  end: number;
  rest: StringReader;
  stack: Stack;
}

export function executeParserSync<T, Ctx>(parser: Parser<T, Ctx>, input: StringReader, ctx: Ctx): ParseResult<T> {
  const running = parser(input, [], ctx);

  const [rootJob, unwrapRoot] = createJob(running);

  const stack: Array<Job<any, Ctx>> = [rootJob];

  let value: JobResult | undefined = undefined;

  while (true) {
    const current = stack[stack.length - 1];
    const step = current.parser.next(value!);
    if (step.done) {
      value = {
        ref: current.ref,
        value: step.value,
      };
      stack.pop();
      if (stack.length === 0) {
        break;
      }
    } else {
      value = undefined;
      stack.push(step.value);
    }
  }

  return unwrapRoot(value);
}

const ASYNC_JOB_DURATION = 5;

export function executeParserAsync<T, Ctx>(
  parser: Parser<T, Ctx>,
  input: StringReader,
  ctx: Ctx
): Promise<ParseResult<T>> {
  return new Promise((resolve) => {
    const running = parser(input, [], ctx);
    const [rootJob] = createJob(running);
    const stack: Array<Job<any, Ctx>> = [rootJob];
    let value: JobResult | undefined = undefined;

    // Should we schedule immediatly ?
    run();

    // run for
    function run() {
      const endTime = Date.now() + ASYNC_JOB_DURATION;
      while (true) {
        if (Date.now() >= endTime) {
          setTimeout(run, 0);
          return;
        }
        const current = stack[stack.length - 1];
        const step = current.parser.next(value!);
        if (step.done) {
          value = {
            ref: current.ref,
            value: step.value,
          };
          stack.pop();
          if (stack.length === 0) {
            break;
          }
        } else {
          value = undefined;
          stack.push(step.value);
        }
      }

      if (value === undefined) {
        throw new Error('TODO: handle this');
      }

      resolve(value.value as any);
    }
  });
}

export type ParseResult<T> = ParseResultSuccess<T> | ParseResultFailure;

export type ParserJob<T, Ctx> = Generator<Job<any, Ctx>, ParseResult<T>, JobResult>;

export type Parser<T, Ctx> = {
  ParserName: string;
  (input: StringReader, skip: Array<Parser<any, Ctx>>, ctx: Ctx): ParserJob<T, Ctx>;
};

export function ParseFailure(stack: StackItem): ParseResultFailure {
  return {
    type: 'Failure',
    stack: cleanupStackItem(stack),
  };
}

export function ParseSuccess<T>(start: number, rest: StringReader, value: T, stack: Stack): ParseResultSuccess<T> {
  return {
    type: 'Success',
    rest,
    start,
    end: rest.position,
    value,
    stack: cleanupStack(stack),
  };
}

function cleanupStackItem(stack: StackItem): StackItem {
  const sub = stack.stack;
  if (sub === null) {
    return stack;
  }
  if (Array.isArray(sub)) {
    if (sub.length === 0) {
      return {
        ...stack,
        stack: null,
      };
    }
    if (sub.length === 1) {
      const subStack = cleanupStackItem(sub[0]);
      if (subStack.position === stack.position) {
        return {
          ...stack,
          message: `${stack.message} > ${subStack.message}`,
          stack: subStack.stack,
        };
      }
      return {
        ...stack,
        stack: subStack,
      };
    }
    return {
      ...stack,
      stack: cleanupStack(sub),
    };
  }
  // sub is item
  const clean = cleanupStackItem(sub);
  if (clean.position === stack.position) {
    return {
      ...stack,
      message: `${stack.message} > ${clean.message}`,
      stack: clean.stack,
    };
  }
  return {
    ...stack,
    stack: clean,
  };
}

function cleanupStack(stack: Stack): Stack {
  if (Array.isArray(stack)) {
    return stack.map(cleanupStackItem);
  }
  return cleanupStackItem(stack);
}

export function mergeStacks(left: Stack, ...stacks: Array<StackOrNull>): Array<StackItem> {
  let result: Array<StackItem> = Array.isArray(left) ? left : [left];
  stacks.forEach((right) => {
    if (right === null) {
      return;
    }
    const rightArr = Array.isArray(right) ? right : [right];
    result = [...result, ...rightArr];
  });
  return result;
}

function expectNever<T extends never>(_val: T): never {
  throw new DocsyUnexpectedError(`Expected never !`);
}

function createParser<T, Ctx>(
  name: string,
  fn: (input: StringReader, skip: Array<Parser<any, Ctx>>, ctx: Ctx) => ParserJob<T, Ctx>
): Parser<T, Ctx> {
  const parser: Parser<T, Ctx> = fn as any;
  parser.ParserName = name;
  return parser;
}

export function named<T, Ctx>(name: string, parser: Parser<T, Ctx>): Parser<T, Ctx> {
  return createParser(name, parser);
}

export function many<T, Ctx>(parser: Parser<T, Ctx>): Parser<Array<T>, Ctx> {
  const manyParser = createParser<Array<T>, Ctx>(`Many(${parser.ParserName})`, function* (input, parent, ctx) {
    let nextInput = input;
    let stacks: StackOrNull = [];
    let items: Array<T> = [];
    let next: ParseResult<T>;
    while (true) {
      const [parserJob, unwrapParser] = createJob(parser(nextInput, items.length === 0 ? parent : [], ctx));
      next = unwrapParser(yield parserJob);
      if (next.type === 'Failure') {
        stacks.push(next.stack);
        break;
      }
      if (next.type === 'Success') {
        stacks = mergeStacks(stacks, next.stack);
        items.push(next.value);
        nextInput = next.rest;
      }
    }
    return ParseSuccess(input.position, nextInput, items, {
      message: `✔ Many ${parser.ParserName} ended (found ${items.length})`,
      position: input.position,
      stack: stacks,
    });
  });
  return manyParser;
}

export function manyBetween<Begin, Item, End, Ctx>(
  name: string | null,
  begin: Parser<Begin, Ctx>,
  item: Parser<Item, Ctx>,
  end: Parser<End, Ctx>
): Parser<[Begin, Array<Item>, End], Ctx> {
  const nameResolved = name === null ? `${begin.ParserName} Many(${item.ParserName}) ${end.ParserName}` : name;
  const manyBetweenParser = createParser<[Begin, Array<Item>, End], Ctx>(nameResolved, function* (input, skip, ctx) {
    let current = input;
    const [beginJob, unwrapBegin] = createJob(begin(current, skip, ctx));
    const beginResult = unwrapBegin(yield beginJob);
    if (beginResult.type === 'Failure') {
      return ParseFailure({
        message: `✘ ${nameResolved}`,
        position: current.position,
        stack: {
          message: `✘ Begin ${begin.ParserName}`,
          position: current.position,
          stack: beginResult.stack,
        },
      });
    }
    current = beginResult.rest;
    let stacks: StackOrNull = beginResult.stack;
    const [endJob, unwrapEnd] = createJob(end(current, skip, ctx));
    let endResult = unwrapEnd(yield endJob);
    const items: Array<Item> = [];
    while (endResult.type === 'Failure') {
      if (current.size === 0) {
        return ParseFailure({
          message: `✘ ${nameResolved}`,
          position: current.position,
          stack: mergeStacks(stacks, {
            message: `✘ Unexpected EOF`,
            position: current.position,
            stack: null,
          }),
        });
      }
      const [itemJob, unwrapItem] = createJob(item(current, skip, ctx));
      const itemResult = unwrapItem(yield itemJob);
      if (itemResult.type === 'Failure') {
        return ParseFailure({
          message: `✘ ${nameResolved}`,
          position: current.position,
          stack: mergeStacks(stacks, endResult.stack, {
            message: `✘ ${item.ParserName}`,
            position: current.position,
            stack: itemResult.stack,
          }),
        });
      }
      items.push(itemResult.value);
      stacks = mergeStacks(stacks, itemResult.stack);
      current = itemResult.rest;
      const [endJob, unwrapEnd] = createJob(end(current, skip, ctx));
      endResult = unwrapEnd(yield endJob);
    }
    const result: [Begin, Array<Item>, End] = [beginResult.value, items, endResult.value];
    return ParseSuccess(input.position, endResult.rest, result, {
      message: `✔ ${nameResolved}`,
      position: input.position,
      stack: stacks,
    });
  });
  return manyBetweenParser;
}

export type ManySepByResult<T> = { items: Array<T>; trailing: boolean };

export function manySepBy<T, Ctx>(
  itemParser: Parser<T, Ctx>,
  sepParser: Parser<any, Ctx>,
  allowTrailing: boolean
): Parser<ManySepByResult<T>, Ctx> {
  const name = `ManySepBy(${itemParser.ParserName}, ${sepParser.ParserName})`;
  return createParser<ManySepByResult<T>, Ctx>(name, function* (input, parent, ctx) {
    let nextInput = input;
    let items: Array<T> = [];
    // parse first
    const [itemJob, unwrapItem] = createJob(itemParser(nextInput, parent, ctx));
    const next = unwrapItem(yield itemJob);
    if (next.type === 'Failure') {
      return ParseSuccess<ManySepByResult<T>>(
        input.position,
        nextInput,
        { items, trailing: false },
        {
          message: `✘ ${name}`,
          position: nextInput.position,
          stack: next.stack,
        }
      );
    }
    if (next.type === 'Success') {
      items.push(next.value);
      nextInput = next.rest;
    }
    let nextSep: ParseResult<any>;
    while (true) {
      const [sepJob, unwrapSep] = createJob(sepParser(nextInput, [], ctx));
      nextSep = unwrapSep(yield sepJob);
      if (nextSep.type === 'Failure') {
        break;
      }
      const [itemJob, unwrapItem] = createJob(itemParser(nextSep.rest, [], ctx));
      const nextItem = unwrapItem(yield itemJob);
      if (nextItem.type === 'Failure') {
        if (allowTrailing) {
          return ParseSuccess<ManySepByResult<T>>(
            input.position,
            nextSep.rest,
            { items, trailing: true },
            {
              message: `✔ ${name} ended with trailing separator`,
              position: input.position,
              stack: nextSep.stack,
            }
          );
        }
        // fail
        return ParseFailure({
          message: `✘ Expected ${itemParser.ParserName} after ${sepParser.ParserName}`,
          position: nextSep.rest.position,
          stack: nextItem.stack,
        });
      }
      if (nextItem.type === 'Success') {
        items.push(nextItem.value);
        nextInput = nextItem.rest;
      }
    }
    return ParseSuccess<ManySepByResult<T>>(
      input.position,
      nextInput,
      { items, trailing: false },
      {
        message: `✔ ${name} ended`,
        position: input.position,
        stack: nextSep.stack,
      }
    );
  });
}

export function maybe<T, Ctx>(parser: Parser<T, Ctx>): Parser<T | null, Ctx> {
  const maybeParser: Parser<T | null, Ctx> = createParser<T | null, Ctx>(
    `Maybe(${parser.ParserName})`,
    function* (input, parent, ctx) {
      let nextInput = input;
      const [job, unwrap] = createJob(parser(nextInput, parent, ctx));
      const next = unwrap(yield job);
      if (next.type === 'Failure') {
        return ParseSuccess(input.position, input, null, {
          message: `✔ Maybe ${parser.ParserName}`,
          position: input.position,
          stack: next.stack,
        });
      }
      return ParseSuccess(input.position, next.rest, next.value, next.stack);
    }
  );
  return maybeParser;
}

// prettier-ignore
export function oneOf<R1, R2, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>): Parser<R1 | R2, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>): Parser<R1 | R2 | R3, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>): Parser<R1 | R2 | R3 | R4, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, R5, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>): Parser<R1 | R2 | R3 | R4 | R5, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, R5, R6, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>): Parser<R1 | R2 | R3 | R4 | R5 | R6, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, R5, R6, R7, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>, p7: Parser<R7, C>): Parser<R1 | R2 | R3 | R4 | R5 | R6 | R7, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, R5, R6, R7, R8, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>, p7: Parser<R7, C>, p8: Parser<R8, C>): Parser<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, R5, R6, R7, R8, R9, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>, p7: Parser<R7, C>, p8: Parser<R8, C>, p9: Parser<R9, C>): Parser<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>, p7: Parser<R7, C>, p8: Parser<R8, C>, p9: Parser<R9, C>, p10: Parser<R10, C>): Parser<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10, C>;
// prettier-ignore
export function oneOf<R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>, p7: Parser<R7, C>, p8: Parser<R8, C>, p9: Parser<R9, C>, p10: Parser<R10, C>, p11: Parser<R11, C>): Parser<R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 | R10 | R11, C>;
export function oneOf<V, Ctx>(name: string | null, ...parsers: Array<Parser<V, Ctx>>): Parser<V, Ctx> {
  const nameResolved = name === null ? `OneOf(${parsers.map((p) => p.ParserName).join(',')})` : name;
  const onOfParser = createParser<V, Ctx>(nameResolved, function* (input, skip, ctx) {
    let stacks: StackOrNull = [];
    for (const parser of parsers) {
      if (skip.includes(parser)) {
        stacks.push({
          message: `✘ Skip ${parser.ParserName}`,
          position: input.position,
          stack: null,
        });
        continue;
      }
      const [job, unwrap] = createJob(parser(input, [...skip], ctx));
      const next = unwrap(yield job);
      if (next.type === 'Success') {
        return ParseSuccess(input.position, next.rest, next.value, {
          message: `✔ ${nameResolved}`,
          position: input.position,
          stack: mergeStacks(stacks, {
            message: `✔ ${parser.ParserName}`,
            position: input.position,
            stack: next.stack,
          }),
        });
      }
      if (next.type === 'Failure') {
        stacks.push(next.stack);
        continue;
      }
      expectNever(next);
    }
    return ParseFailure({
      message: `✘ ${nameResolved}`,
      position: input.position,
      stack: stacks,
    });
  });
  return onOfParser;
}

export function transformSuccess<T, U, Ctx>(
  parser: Parser<T, Ctx>,
  transformer: (val: T, start: number, end: number, ctx: Ctx) => U
): Parser<U, Ctx> {
  return createParser<U, Ctx>(parser.ParserName, function* (input, skip, ctx) {
    const [job, unwrap] = createJob(parser(input, skip, ctx));
    const next = unwrap(yield job);
    if (next.type === 'Success') {
      return {
        ...next,
        value: transformer(next.value, next.start, next.end, ctx),
      };
    }
    return next;
  });
}

export function transform<T, U, Ctx>(
  parser: Parser<T, Ctx>,
  transformer: (result: ParseResult<T>, ctx: Ctx) => ParseResult<U>
): Parser<U, Ctx> {
  return createParser<U, Ctx>(parser.ParserName, function* (input, skip, ctx) {
    const [job, unwrap] = createJob(parser(input, skip, ctx));
    const next = unwrap(yield job);
    return transformer(next, ctx);
  });
}

export function whileNotMatch<Ctx>(name: string | null, matchers: Array<string>): Parser<string, Ctx> {
  const nameResolved = name !== null ? name : `WhileNot(${matchers.join(', ')})`;
  return createParser<string, Ctx>(nameResolved, function* (input) {
    let content = '';
    let current = input;
    if (current.empty) {
      return ParseFailure({
        message: `✘ ${nameResolved}: unexpected EOF`,
        position: input.position,
        stack: null,
      });
    }
    const noMatches = () => matchers.every((matcher) => current.peek(matcher.length) !== matcher);
    while (!current.empty && noMatches()) {
      content += current.peek();
      current = current.skip();
    }
    if (content.length === 0) {
      return ParseFailure({
        message: `✘ ${nameResolved} (received '${current.peek()}')`,
        position: input.position,
        stack: null,
      });
    }
    return ParseSuccess(input.position, current, content, {
      message: `✔ ${nameResolved} (stopped at ${current.position} by '${current.peek().replace(/\n/, '\\n')}')`,
      position: input.position,
      stack: null,
    });
  });
}

export function whileMatch<Ctx>(
  name: string,
  matcher: (ch1: string, ch2: string, ch3: string) => boolean
): Parser<string, Ctx> {
  return createParser(name, function* (input) {
    let content = '';
    let current = input;
    if (current.empty) {
      return ParseFailure({
        message: `✘ ${name}: unexpected EOF`,
        position: input.position,
        stack: null,
      });
    }
    while (!current.empty && matcher(current.peek(), current.peek(2), current.peek(3))) {
      content += current.peek();
      current = current.skip();
    }
    if (content.length === 0) {
      return ParseFailure({
        message: `✘ ${name} (received '${current.peek()}')`,
        position: input.position,
        stack: null,
      });
    }
    return ParseSuccess(input.position, current, content, {
      message: `✔ ${name} (stopped at ${current.position} by '${current.peek().replace(/\n/, '\\n')}')`,
      position: input.position,
      stack: null,
    });
  });
}

export function singleChar<Ctx>(name: string, matcher?: (char: string) => boolean): Parser<string, Ctx> {
  return createParser(name, function* (input) {
    if (input.empty) {
      return ParseFailure({
        message: `✘ ${name}: Unexpected EOF`,
        position: input.position,
        stack: null,
      });
    }
    const value = input.peek();
    if (matcher && !matcher(value)) {
      return ParseFailure({
        message: `✘ ${name} (received '${value}')`,
        position: input.position,
        stack: null,
      });
    }
    const rest = input.skip();
    return ParseSuccess(input.position, rest, value, {
      message: `✔ ${name}`,
      position: input.position,
      stack: null,
    });
  });
}

export function exact<T extends string, Ctx>(str: T, name: string = `'${str}'`): Parser<T, Ctx> {
  const nameResolved = name.replace(/\n/, '\\n');
  return createParser(nameResolved, function* (input) {
    const peek = input.peek(str.length);
    if (peek.length < str.length) {
      return ParseFailure({
        message: `✘ ${nameResolved}: Unexpected EOF`,
        position: input.position,
        stack: null,
      });
    }
    if (peek !== str) {
      return ParseFailure({
        message: `✘ ${nameResolved} (received '${peek.replace(/\n/, '\\n')}')`,
        position: input.position,
        stack: null,
      });
    }
    const nextInput = input.skip(str.length);
    return ParseSuccess(input.position, nextInput, str, {
      message: `✔ ${nameResolved}`,
      position: input.position,
      stack: null,
    });
  });
}

export function eof<Ctx>(): Parser<null, Ctx> {
  return createParser('EOF', function* (input) {
    if (input.empty) {
      return ParseSuccess(input.position, input, null, {
        message: `✔ EOF did match`,
        position: input.position,
        stack: null,
      });
    }
    return ParseFailure({
      message: `✘ Expected EOF, received '${input.peek().replace(/\n/, '\\n')}'`,
      position: input.position,
      stack: null,
    });
  });
}

// prettier-ignore
export function pipe<R1, R2, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>): Parser<[R1, R2], C>;
// prettier-ignore
export function pipe<R1, R2, R3, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>): Parser<[R1, R2, R3], C>;
// prettier-ignore
export function pipe<R1, R2, R3, R4, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>): Parser<[R1, R2, R3, R4], C>;
// prettier-ignore
export function pipe<R1, R2, R3, R4, R5, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>): Parser<[R1, R2, R3, R4, R5], C>;
// prettier-ignore
export function pipe<R1, R2, R3, R4, R5, R6, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>): Parser<[R1, R2, R3, R4, R5, R6], C>;
// prettier-ignore
export function pipe<R1, R2, R3, R4, R5, R6, R7, C>(name: string | null, p1: Parser<R1, C>, p2: Parser<R2, C>, p3: Parser<R3, C>, p4: Parser<R4, C>, p5: Parser<R5, C>, p6: Parser<R6, C>, p7: Parser<R7, C>): Parser<[R1, R2, R3, R4, R5, R6, R7], C>;
export function pipe<V, Ctx>(name: string | null, ...parsers: Array<Parser<V, Ctx>>): Parser<Array<V>, Ctx> {
  const nameResolved = name === null ? `[${parsers.map((p) => p.ParserName).join(' ')}]` : name;
  const pipeParser = createParser<Array<V>, Ctx>(nameResolved, function* (input, skip, ctx) {
    let current = input;
    const result: Array<V> = [];
    let stacks: Array<StackItem> = [];
    if (skip.includes(parsers[0])) {
      return ParseFailure({
        message: `✘ ${nameResolved}`,
        position: current.position,
        stack: {
          message: `✘ Skip ${parsers[0].ParserName}`,
          position: current.position,
          stack: null,
        },
      });
    }

    for (let i = 0; i < parsers.length; i++) {
      const parser = parsers[i];
      const [job, unwrap] = createJob(parser(current, i === 0 ? [...skip, parser] : [], ctx));
      const next = unwrap(yield job);
      if (next.type === 'Failure') {
        stacks.push(next.stack);
        // const prevError = prevResult === null ? null : prevResult.result.stack;
        return ParseFailure({
          message: `✘ ${nameResolved}`,
          position: current.position,
          stack: stacks,
        });
      }
      if (next.type === 'Success') {
        stacks = mergeStacks(stacks, next.stack);
        current = next.rest;
        result.push(next.value);
      }
    }
    return ParseSuccess(input.position, current, result, stacks);
  });
  return pipeParser;
}

// function onError<T>(
//   parser: Parser<T>,
//   onError: (error: StackItem, input: StringReader) => ParseResult<T>
// ): Parser<T> {
//   return createParser(`OnError(${parser.ParserName})`, (input, skip) => {
//     const next = parser(input, skip);
//     if (next.type === 'Success') {
//       return next;
//     }
//     return onError(next.stack, input);
//   });
// }

// if error use error of another parser
// function convertError<T>(parser: Parser<T>, errorParser: Parser<any>): Parser<T> {
//   return createParser(parser.ParserName, (input, skip) => {
//     const next = parser(input, skip);
//     if (next.type === 'Success') {
//       return next;
//     }
//     const childError = errorParser(input, skip);
//     if (childError.type === 'Success') {
//       // errorParser succeed, return the original error
//       return next;
//     }
//     return ParseFailure(childError.stack);
//   });
// }

export function lazy<T, Ctx>(name: string, exec: () => Parser<T, Ctx>): Parser<T, Ctx> {
  let resolved: Parser<T, Ctx> | null = null;
  const parser = createParser<T, Ctx>(name, (input, skip, ctx) => {
    if (resolved == null) {
      resolved = exec();
    }
    return resolved(input, skip, ctx);
  });
  return parser;
}

export function reduceRight<I, C, O, Ctx>(
  name: string,
  init: Parser<I, Ctx>,
  condition: Parser<C, Ctx>,
  transform: (result: ParseResultSuccess<I | O>, right: ParseResultSuccess<C>, ctx: Ctx) => ParseResult<O>
): Parser<O, Ctx> {
  const reduceRightParser = createParser<O, Ctx>(name, function* (input, skip, ctx) {
    if (skip.includes(init)) {
      return ParseFailure({
        message: `✘ ${name}`,
        position: input.position,
        stack: {
          message: `✘ Skip ${init.ParserName}`,
          position: input.position,
          stack: null,
        },
      });
    }
    const [initJob, unwrapInit] = createJob(init(input, [...skip, init], ctx));
    let initParsed = unwrapInit(yield initJob);
    if (initParsed.type === 'Failure') {
      return ParseFailure({
        message: `✘ ${name}`,
        position: input.position,
        stack: initParsed.stack,
      });
    }
    let current = initParsed.rest;
    const [conditionJob, unwrapCondition] = createJob(condition(current, [], ctx));
    let cond = unwrapCondition(yield conditionJob);
    if (cond.type === 'Failure') {
      return ParseFailure({
        message: `✘ ${name}`,
        position: current.position,
        stack: cond.stack,
      });
    }
    // let count = 0;
    current = cond.rest;
    const firstResult = transform(initParsed, cond, ctx);
    if (firstResult.type === 'Failure') {
      return firstResult;
    }
    let result = firstResult;
    while (cond.type === 'Success') {
      current = cond.rest;
      const [conditionJob, unwrapCondition] = createJob(condition(current, [], ctx));
      cond = unwrapCondition(yield conditionJob);
      if (cond.type === 'Success') {
        // count++;
        const nextResult = transform(result, cond, ctx);
        if (nextResult.type === 'Failure') {
          return nextResult;
        }
        current = nextResult.rest;
        result = nextResult;
      }
    }
    return result;
    // return ParseSuccess(input, current, result, {
    //   message: `✔ ${name} (reduce right) ended after ${count} items`,
    //   position: current.position,
    //   stack: cond.stack,
    // });
  });
  return reduceRightParser;
}
