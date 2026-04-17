{
  "name": "Connect",
  "slug": "connect",
  "unique": false,
  "assignable_to": "any",
  "use_default_actions": true,
  "selectors": {
    "category": "Storage",
    "imported": false,
    "provider": "AWS",
    "sub_category": "Object Storage"
  },
  "attributes": {
    "schema": {
      "type": "object",
      "$schema": "http://json-schema.org/draft-07/schema#",
      "required": ["access_level"],
      "properties": {
        "access_level": {
          "enum": ["read", "write", "read-write"],
          "type": "string",
          "title": "Access Level",
          "default": "read-write",
          "editableOn": ["create", "update"],
          "description": "Permission level: read (GetObject/ListBucket), write (PutObject/DeleteObject), read-write (both)",
          "order": 1
        },
        "path_prefix": {
          "type": "string",
          "title": "Path Prefix",
          "default": "",
          "description": "Optional S3 key prefix to scope the IAM permissions (e.g., 'uploads/'). Empty means full bucket access.",
          "editableOn": ["create", "update"],
          "order": 2
        },
        "aws_access_key_id": {
          "type": "string",
          "title": "AWS Access Key ID",
          "export": {"type": "environment_variable"},
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM user access key ID (auto-populated after link creation)",
          "order": 3
        },
        "aws_secret_access_key": {
          "type": "string",
          "title": "AWS Secret Access Key",
          "export": {"type": "environment_variable", "secret": true},
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM user secret access key (auto-populated, delivered as secret env var)",
          "order": 4
        },
        "iam_user_name": {
          "type": "string",
          "export": false,
          "visibleOn": [],
          "editableOn": [],
          "description": "Internal IAM user name created for this link"
        }
      }
    },
    "values": {}
  }
}
