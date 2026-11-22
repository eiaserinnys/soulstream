import {requestOrchestratorCheck} from "@seosoyoung/soul-ui/lib/orchestrator-connection";
import { useEffect, useRef } from "react";
import { useOrchestratorStore, type OrchestratorNode } from "../store/orchestrator-store";

export function useNodes(onConnectionError?: () => void) {
  const { setNode, removeNode, setNodes, setConnectionStatus } =
    useOrchestratorStore();
  const retryRef = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let disposed = false;

    function connect() {
      if (disposed) return;
      const connection = new EventSource("/api/nodes/stream");
      es = connection;

      connection.onopen = () => {
        retryRef.current = 0;
      };

      connection.addEventListener("snapshot", (e) => {
        const nodes: OrchestratorNode[] = JSON.parse(e.data);
        setNodes(nodes);
        setConnectionStatus("connected");
      });

      connection.addEventListener("node_connected", (e) => {
        const node: OrchestratorNode = JSON.parse(e.data);
        setNode(node);
      });

      connection.addEventListener("node_disconnected", (e) => {
        const { nodeId } = JSON.parse(e.data);
        removeNode(nodeId);
      });

      connection.addEventListener("node_updated", (e) => {
        const node: OrchestratorNode = JSON.parse(e.data);
        setNode(node);
      });

      connection.onerror = (event) => {
        if (disposed || es !== connection || event instanceof MessageEvent) return;
        requestOrchestratorCheck();
        try {
          onConnectionError?.();
        } catch (error) {
          console.error("[Nodes SSE] Connection error callback failed:", error);
        }
        connection.close();
        setConnectionStatus("error");
        // Exponential backoff reconnect
        const delay = Math.min(1000 * 2 ** retryRef.current, 30000);
        retryRef.current++;
        setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      disposed = true;
      es?.close();
    };
  }, [onConnectionError, setNode, removeNode, setNodes, setConnectionStatus]);
}
