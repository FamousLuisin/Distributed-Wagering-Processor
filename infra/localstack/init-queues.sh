#!/bin/bash
set -euo pipefail

dlq_url="$(awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false \
  --query QueueUrl \
  --output text)"

dlq_arn="$(awslocal sqs get-queue-attributes \
  --queue-url "$dlq_url" \
  --attribute-names QueueArn \
  --query 'Attributes.QueueArn' \
  --output text)"

redrive_policy="$(python3 -c 'import json, sys; print(json.dumps({"deadLetterTargetArn": sys.argv[1], "maxReceiveCount": "5"}))' "$dlq_arn")"
source_queue_attributes="$(python3 -c 'import json, sys; print(json.dumps({"FifoQueue": "true", "ContentBasedDeduplication": "false", "RedrivePolicy": sys.argv[1]}))' "$redrive_policy")"
awslocal sqs create-queue \
  --queue-name wager-transactions.fifo \
  --attributes "$source_queue_attributes"

awslocal sqs create-queue \
  --queue-name wager-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
