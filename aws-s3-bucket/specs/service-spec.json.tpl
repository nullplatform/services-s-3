{
  "name": "AWS S3 Bucket",
  "slug": "aws-s3-bucket",
  "type": "dependency",
  "unique": false,
  "assignable_to": "any",
  "use_default_actions": true,
  "available_links": ["connect"],
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
      "required": ["bucket_name_suffix"],
      "properties": {
        "bucket_name_suffix": {
          "type": "string",
          "title": "Bucket Name Suffix",
          "description": "Suffix used to build the bucket name (combined with service name). Must be lowercase alphanumeric with hyphens, 3-40 chars.",
          "pattern": "^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$",
          "editableOn": ["create"],
          "order": 1
        },
        "versioning": {
          "type": "boolean",
          "title": "Versioning",
          "default": true,
          "description": "Enable S3 versioning to keep multiple versions of each object",
          "editableOn": ["create", "update"],
          "order": 2
        },
        "encryption": {
          "type": "string",
          "title": "Encryption",
          "default": "AES256",
          "enum": ["AES256", "aws:kms"],
          "description": "Server-side encryption algorithm (AES256 uses S3-managed keys; aws:kms uses the AWS-managed KMS key)",
          "editableOn": ["create", "update"],
          "order": 3
        },
        "public_access_block": {
          "type": "boolean",
          "title": "Block Public Access",
          "default": true,
          "description": "Block all public access to the bucket (recommended)",
          "editableOn": ["create", "update"],
          "order": 4
        },
        "force_destroy": {
          "type": "boolean",
          "title": "Force Destroy",
          "default": false,
          "description": "Allow deleting the bucket even if it contains objects. USE WITH CAUTION.",
          "editableOn": ["create", "update"],
          "order": 5
        },
        "bucket_name": {
          "type": "string",
          "title": "Bucket Name",
          "export": true,
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "Actual S3 bucket name (auto-populated after creation)",
          "order": 6
        },
        "bucket_arn": {
          "type": "string",
          "title": "Bucket ARN",
          "export": true,
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "S3 bucket ARN (auto-populated after creation)",
          "order": 7
        },
        "bucket_region": {
          "type": "string",
          "title": "Bucket Region",
          "export": true,
          "visibleOn": ["read"],
          "editableOn": [],
          "description": "AWS region where the bucket lives (auto-populated after creation)",
          "order": 8
        }
      }
    },
    "values": {}
  }
}
