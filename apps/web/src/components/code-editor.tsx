// SPDX-License-Identifier: AGPL-3.0-only
import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { javascript, javascriptLanguage } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { useContext, useMemo } from "react";
import { VariablesContext } from "./expression-input";

const GLOBALS = [
  { label: "$input", detail: "data from the previous node" },
  { label: "$trigger", detail: "data of the trigger" },
  { label: "$node", detail: '$node["Name"].data' },
  { label: "$vars", detail: "project variables (read only)" },
  { label: "$run", detail: "info about this run" },
];

const theme = EditorView.theme({
  "&": { fontSize: "12px", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none" },
  ".cm-content": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
  ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, monospace)" },
});

const isDark = () =>
  typeof document !== "undefined" && document.documentElement.classList.contains("dark");

/** The code of the Code node: JavaScript with colors and suggestions. */
export function CodeEditor({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const variables = useContext(VariablesContext);
  const extensions = useMemo(
    () => [
      javascript(),
      theme,
      autocompletion(),
      EditorView.contentAttributes.of({ "aria-label": "Code" }),
    ],
    [],
  );
  const hints = useMemo(() => {
    const names = variables.map((v) => ({ label: v.key, detail: v.preview, type: "property" }));
    return (context: CompletionContext) => {
      const vars = context.matchBefore(/\$vars\.\w*/);
      if (vars) {
        return { from: vars.from + "$vars.".length, options: names };
      }
      const word = context.matchBefore(/\$\w*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      return {
        from: word.from,
        options: GLOBALS.map((g) => ({ ...g, type: "variable" })),
      };
    };
  }, [variables]);
  return (
    <div id={id} className="overflow-hidden rounded-md border bg-card">
      <CodeMirror
        value={value}
        height="16rem"
        theme={isDark() ? "dark" : "light"}
        extensions={[
          ...extensions,
          // Added to the suggestions of the JavaScript mode.
          javascriptLanguage.data.of({ autocomplete: hints }),
        ]}
        basicSetup={{ foldGutter: false, highlightActiveLine: false }}
        onChange={onChange}
      />
    </div>
  );
}
