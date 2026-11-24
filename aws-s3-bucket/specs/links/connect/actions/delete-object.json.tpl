{
  "name": "Delete object",
  "slug": "delete-object",
  "type": "custom",
  "annotations": {},
  "retryable": false,
  "parallelize": true,
  "parameters": {
    "schema": {
      "type": "object",
      "$schema": "http://json-schema.org/draft-07/schema#",
      "required": [
        "key"
      ],
      "uiSchema": {
        "type": "VerticalLayout",
        "elements": [
          {
            "type": "Control",
            "scope": "#/properties/key"
          }
        ]
      },
      "properties": {
        "key": {
          "type": "string",
          "title": "Key",
          "minLength": 1,
          "maxLength": 1024,
          "description": "Relative object key (no leading or trailing slash), inside the link's path prefix.",
          "pattern": "^[^/].*[^/]$|^[^/]$"
        }
      },
      "additionalProperties": false
    },
    "values": {}
  },
  "results": {
    "schema": {
      "type": "object",
      "required": [],
      "properties": {
        "key": {
          "type": "string",
          "title": "Key"
        },
        "status": {
          "type": "string",
          "title": "Status",
          "enum": [
            "deleted",
            "failed"
          ]
        },
        "message": {
          "type": "string",
          "title": "Message"
        }
      }
    },
    "values": {}
  }
}
