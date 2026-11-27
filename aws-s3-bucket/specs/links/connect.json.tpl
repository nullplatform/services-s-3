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
          "maxLength": 512,
          "pattern": "^[^*?$\\x00-\\x1f\\x7f]*$",
          "description": "Optional S3 key prefix to scope the IAM permissions (e.g., 'uploads/'). It is a folder: 'uploads' is read as 'uploads/', never 'uploads-old/'. Empty means full bucket access. Cannot contain *, ? or $ (IAM wildcards and policy variables).",
          "editableOn": ["create", "update"],
          "order": 2
        },
        "browser_enabled": {
          "type": "boolean",
          "title": "S3 browser",
          "default": false,
          "editableOn": ["create", "update"],
          "description": "Let the people who can read this link browse the bucket from the dashboard, with this link's access level and path prefix. Off by default: turn it on only when everyone who can see the link may also see the files. Turning it on creates an IAM role that only the S3 browser can assume; turning it off removes it. The application's access key is the same either way.",
          "order": 3
        },
        "aws_access_key_id": {
          "type": "string",
          "title": "AWS Access Key ID",
          "export": {"type": "environment_variable"},
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM user access key ID (auto-populated after link creation)",
          "order": 4
        },
        "aws_secret_access_key": {
          "type": "string",
          "title": "AWS Secret Access Key",
          "export": {"type": "environment_variable", "secret": true},
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM user secret access key (auto-populated, delivered as secret env var)",
          "order": 5
        },
        "iam_user_name": {
          "type": "string",
          "export": false,
          "visibleOn": [],
          "editableOn": [],
          "description": "Internal IAM user name created for this link"
        },
        "role_arn": {
          "type": "string",
          "title": "Role ARN",
          "export": false,
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM role the S3 browser assumes for this link (auto-populated while the S3 browser is on, empty otherwise). The application cannot assume it.",
          "order": 6
        },
        "iam_role_name": {
          "type": "string",
          "export": false,
          "visibleOn": [],
          "editableOn": [],
          "description": "Internal IAM role name created for this link"
        }
      }
    },
    "values": {}
  }
}
