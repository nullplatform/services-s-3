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
          "description": "Optional S3 key prefix to scope the IAM permissions (e.g., 'uploads/'). Empty means full bucket access. Cannot contain *, ? or $ (IAM wildcards and policy variables).",
          "editableOn": ["create", "update"],
          "order": 2
        },
        "credentials": {
          "enum": ["access-key", "role"],
          "type": "string",
          "title": "Credentials",
          "default": "access-key",
          "editableOn": ["create"],
          "description": "How the app authenticates to the bucket. access-key: a dedicated IAM user with a static access key (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). role: no static key; a dedicated IAM role (ROLE_ARN) for the S3 browser, which only the principals trusted by this service can assume. Cannot be changed after the link is created.",
          "order": 3
        },
        "aws_access_key_id": {
          "type": "string",
          "title": "AWS Access Key ID",
          "export": {"type": "environment_variable"},
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM user access key ID (auto-populated after link creation; access-key links only)",
          "order": 4
        },
        "aws_secret_access_key": {
          "type": "string",
          "title": "AWS Secret Access Key",
          "export": {"type": "environment_variable", "secret": true},
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM user secret access key (auto-populated, delivered as secret env var; access-key links only)",
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
          "export": {"type": "environment_variable"},
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "IAM role the app assumes to reach the bucket (auto-populated after link creation; role links only)",
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
