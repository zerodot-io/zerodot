# Editor

## Loops and joins

- An edge can go back to an earlier node. Drag from the **+** of a node to another node, or from the output dot to an input. A loop needs a way out: use an **If** or **Switch** node to choose the edge that goes back, and the edge that leaves.
- A node can have more than one parent. It runs once for each parent that sends data (not once for all of them).
- A node that runs again has a new attempt number in the run page. The page shows the last one.
- A trigger node has no input, so an edge cannot lead into it.
- A run stops with an error after `ZERODOT_MAX_NODE_RUNS` node runs (default 1000). This stops a loop that does not end.
- To remove an edge, put the pointer on it and click the **X**.

### Loop Over Items

The `Loop Over Items` node runs the nodes on its `loop` output once for each item (or batch) of a list.

1. Set `list` to an expression for the list, for example `{{ $input.users }}`. Set `batchSize` (default 1).
2. Connect the `loop` output to the nodes that do the work. Connect the last of them back to the input of the loop node (the node has one input).
3. Connect the `done` output to the nodes that run after the last pass.

On each pass the nodes on `loop` get `{ items, item, index, total }`. `items` is the batch, `item` is its first element, `index` is the position of the first element in the list, and `total` is the length of the list. When the list is empty, the loop goes to `done` at once. `done` sends an array: the data that came back, one entry for each pass. A pass that does not come back to the loop node (for example an `If` branch that ends) ends the whole loop, and `done` does not run.

All node runs of a loop count against `ZERODOT_MAX_NODE_RUNS` (default 1000). A loop of 200 items with 4 nodes in its body uses about 1000. Raise the limit for long loops. A wait inside the loop body works: the run stops, and goes on at the same item.

## Test runs in the editor

- **Test run** runs the whole draft graph.
- **Run to here** (node dialog) runs the path from the trigger to the selected node and stops after it. Other branches do not run.
- **Execute step** (node dialog) runs only the selected node. Its input is the last output of the node before it, or the pinned data of that node. The run does not use the pin of the node that you execute. A node with no input data shows a message.
- **Pin output** keeps the output of a node. Test runs use it and skip the node. Production runs ignore pins.
- Test runs use real credentials and write real data.

The REST route `POST /api/v1/workflows/:id/test` takes `toNodeId` for run to node.

## Import and export

- **Export** (editor) downloads the draft as `<name>.zerodot.json`. The same file comes from `GET /api/v1/workflows/:id/export`.
- **Import** (workflow list) makes a new draft from a file. The API route is `POST /api/v1/workflows/import` with `{ "file": ... }`.
- The file holds the graph, the name, and the variable keys that the graph reads. It holds no variable values and no credential data. Pinned data stays in the file: remove it first if it holds private data.
- An import clears a credential that the project does not have. The page lists the nodes that need a new credential, and the variable keys that the project does not have.
