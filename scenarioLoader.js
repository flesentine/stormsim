export async function loadScenario(path) {
  const res = await fetch(path);

  if (!res.ok) {
    throw new Error(`Failed to load scenario from ${path}`);
  }

  const data = await res.json();

  validateScenario(data);

  return data;
}

export function validateScenario(raw) {
  assert(raw.scenario_id, "Missing scenario_id");
  assert(raw.start_node_id, "Missing start_node_id");
  assert(Array.isArray(raw.nodes), "Nodes must be an array");

  const nodeIds = new Set();

  for (const node of raw.nodes) {
    validateNode(node);

    if (nodeIds.has(node.node_id)) {
      throw new Error(`Duplicate node_id: ${node.node_id}`);
    }

    nodeIds.add(node.node_id);
  }

  if (!nodeIds.has(raw.start_node_id)) {
    throw new Error(`start_node_id "${raw.start_node_id}" not found in nodes`);
  }
}

function validateNode(node) {
  assert(node.node_id, "Node missing node_id");
  assert(node.node_type, `Node ${node.node_id} missing node_type`);
  assert(node.context !== undefined, `Node ${node.node_id} missing context`);
  assert(node.prompt !== undefined, `Node ${node.node_id} missing prompt`);

  switch (node.node_type) {
    case "dialogue":
    case "inspection":
    case "decision":
      validateStandardNode(node);
      break;
    case "documentation":
      validateDocumentationNode(node);
      break;
    case "audit_result":
      validateAuditNode(node);
      break;
    default:
      throw new Error(`Invalid node_type: ${node.node_type}`);
  }
}

function validateStandardNode(node) {
  if (!Array.isArray(node.choices)) {
    throw new Error(`Node ${node.node_id} must have choices array`);
  }

  for (const choice of node.choices) {
    assert(choice.choice_id, `Choice missing id in ${node.node_id}`);
    assert(choice.text, `Choice missing text in ${node.node_id}`);
    if (choice.next_node === undefined) {
      throw new Error(
        `Choice ${choice.choice_id} missing next_node in ${node.node_id}`,
      );
    }
  }
}

function validateDocumentationNode(node) {
  if (!Array.isArray(node.fields)) {
    throw new Error(`Documentation node ${node.node_id} missing fields`);
  }

  for (const field of node.fields) {
    assert(field.field_id, `Field missing id in ${node.node_id}`);
    assert(field.label, `Field missing label in ${node.node_id}`);
    assert(field.input_type, `Field missing input_type in ${node.node_id}`);

    if (field.input_type === "single_select" && !Array.isArray(field.options)) {
      throw new Error(`Field ${field.field_id} must have options array`);
    }
  }
}

function validateAuditNode(node) {
  if (node.next_node !== null) {
    throw new Error(`Audit node ${node.node_id} must end with next_node: null`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
