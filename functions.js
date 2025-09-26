

async function handleTools(elevenLabsWs, ws, tool_name, tool_args, tool_call_id, caller_name, number) {
    switch (tool_name) {
        case 'schedule_sorridents_appointment':
            return await schedule_sorridents_appointment(elevenLabsWs, tool_args, tool_call_id, caller_name, number);
        case 'transfer_call':
            return await transfer_call(tool_args, caller_name);
        default:
            return "Tool not recognized";
    }
}

async function schedule_sorridents_appointment(elevenLabsWs, tool_args, tool_call_id, caller_name, number) {
    elevenLabsWs.send(
      JSON.stringify({
        type: "client_tool_result",
        tool_call_id: tool_call_id,
        result: "EXECUTED",
        is_error: false
      })
    );

    try {
      console.log("[Agendamento] Enviando dados para API:", { tool_args, caller_name, number });
      const response = await fetch(`https://api.integrasistema.com:5051/webhook/agendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          arguments: tool_args,
          phone_number: caller_name,
          number: number
        })
      });

      const data =  await response.json();
      console.log("[Agendamento] Resposta da API:", data);
      return data;
    } catch (err) {
      console.error("[Agendamento] Erro ao enviar dados para API:", err);
      return "Agendamento não realizado";
    }
}

async function transfer_call(tool_args = {}, caller_name) {
  const { ramal, host } = tool_args;

  if (!ramal || !host || !caller_name) {
    console.error("[Transferência] Dados insuficientes:", { ramal, host, caller_name });
    return "Dados insuficientes para realizar a transferência.";
  }

  try {
    const payload = {
      ramal,
      caller_name,
      host
    };

    console.log("[Transferência] Payload enviado:", payload);

    const response = await fetch(`https://api.integrasistema.com:5051/webhook/transfer_call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const contentType = response.headers.get("content-type");
    const raw = await response.text();

    let data;
    if (contentType && contentType.includes("application/json")) {
      data = JSON.parse(raw);
    } else {
      data = { error: "Resposta não é JSON", raw };
    }

    console.log("[Transferência] Resposta da API:", data);

    return data;

  } catch (err) {
    console.error("[Transferência] Erro ao enviar dados para API:", err);
    return "Transferência não realizada";
  }
}

export { handleTools };
