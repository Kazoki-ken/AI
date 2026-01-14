
import React, { useEffect, useRef } from 'react';

interface VisualizerProps {
  isActive: boolean;
  isModelSpeaking: boolean;
}

const Visualizer: React.FC<VisualizerProps> = ({ isActive, isModelSpeaking }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!isActive) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationId: number;
    const bars = 30;
    const barWidth = 3;
    const gap = 4;
    const values = new Array(bars).fill(0);

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const color = isModelSpeaking ? '#f87171' : '#60a5fa';

      for (let i = 0; i < bars; i++) {
        const target = Math.random() * (canvas.height * 0.7) + 2;
        values[i] += (target - values[i]) * 0.15;
        
        const x = (i * (barWidth + gap)) + (canvas.width - (bars * (barWidth + gap))) / 2;
        const h = values[i];
        const y = (canvas.height - h) / 2;

        ctx.fillStyle = color;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x, y, barWidth, h, 2);
        } else {
          ctx.rect(x, y, barWidth, h);
        }
        ctx.fill();
      }

      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [isActive, isModelSpeaking]);

  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center gap-2 mb-2">
         <span className={`w-1.5 h-1.5 rounded-full ${isModelSpeaking ? 'bg-red-400 animate-pulse' : 'bg-blue-400 animate-ping'}`} />
         <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
           {isModelSpeaking ? "Sensei gapirmoqda" : "Sizni eshityapman"}
         </span>
      </div>
      <canvas 
        ref={canvasRef} 
        width={250} 
        height={40} 
        className="w-full h-10"
      />
    </div>
  );
};

export default Visualizer;
