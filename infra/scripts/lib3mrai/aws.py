"""boto3 client factory pointed at Floci (or real AWS) via the environment.

CONTRACT: An explicitly EMPTY AWS_ENDPOINT_URL means "use normal AWS endpoint
resolution" — how the Terraform provisioners signal real AWS — and is distinct
from the variable being UNSET, which falls back to Floci. Collapsing the two
sends local runs at real AWS, or the reverse. See [[ADR-0017-floci-local]]
"""

import os

import boto3

DEFAULT_ENDPOINT = "http://localhost:4566"


def endpoint_url() -> str | None:
    """The endpoint override, or None to let boto3 resolve real AWS."""
    value = os.environ.get("AWS_ENDPOINT_URL", DEFAULT_ENDPOINT)
    return value or None


def region() -> str:
    """The configured region, preferring AWS_DEFAULT_REGION as the CLI does."""
    return os.environ.get(
        "AWS_DEFAULT_REGION", os.environ.get("AWS_REGION", "us-east-1")
    )


def client(service: str):
    """A boto3 client for `service`, honoring the Floci endpoint + test creds.

    Credentials default to test/test because that is what Floci accepts and
    what the Makefile exports; against real AWS the ambient credentials in the
    environment take precedence.
    """
    return boto3.client(
        service,
        endpoint_url=endpoint_url(),
        region_name=region(),
        aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID", "test"),
        aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY", "test"),
    )
