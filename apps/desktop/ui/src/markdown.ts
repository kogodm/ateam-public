import { Marked } from 'marked';

export const marked = new Marked({
  tokenizer: {
    del(source) {
      return source.startsWith('~~') ? false : undefined;
    },
  },
});
