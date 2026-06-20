function generateResponse(data) {
  const response = {
    status: 'success',
    data: data
  };
  return JSON.stringify(response);
}

function validateResponse(response) {
  const schema = {
    type: 'object',
    properties: {
      status: { type: 'string' },
      data: { type: 'object' }
    },
    required: ['status', 'data']
  };
  const validate = ajv.compile(schema);
  const valid = validate(response);
  if (!valid) throw new Error('Response validation failed');
}

function handleResponse(data) {
  const response = generateResponse(data);
  validateResponse(JSON.parse(response));
  return response;
}